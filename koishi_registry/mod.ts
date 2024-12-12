import { Context, Service } from '../context.ts'
import Schema from 'schemastery'
import trimEnd from 'lodash.trimend'
import { Awaitable, type Dict } from 'cosmokit'
import { ChangeRecord } from "../npm.ts";
import HTTP from "@cordisjs/plugin-http";
import { parse, compare, parseRange, rangeIntersects } from '@std/semver'
import { Ensure, type RemotePackage } from '@koishijs/registry'
import type { KoishiMarket, NpmRegistry } from "./types.ts";
// import { ObjectList } from "./serializing.ts"; // whatevers, avsc doesn't work with my prefect Schema ;(
import { BSON } from 'bson'
import { Buffer } from "node:buffer";

export type Feature = "downloads" | "rating" | "score" | "scope" | "package" | "manifest" | "verified" | "insecure"

const stopWords = [
    'koishi',
    'plugin',
    'bot',
    'coolq',
    'cqhttp',
]

export function aligned(s: string, pad = 35): string {
    if (s.length > pad)
        return s.substring(0, pad - 3) + '...'
    return s.padEnd(pad, ' ')
}

export function shortnameOf(name: string) { // get shortname of a koishi plugin package
    return name.replace(/(koishi-|^@koishijs\/)plugin-/, '')
}

declare module 'cordis' {
    export interface Context {
        koishi: KoishiRegistry
    }

    export interface Events {
        'koishi/is-verified'(packageName: string, manifest: KoishiMarket.Manifest, meta?: NpmRegistry.Result): Awaitable<boolean | void>

        'koishi/is-insecure'(packageName: string, manifest: KoishiMarket.Manifest, meta?: NpmRegistry.Result): Awaitable<boolean | void>
    }
}

export class KoishiRegistry extends Service {
    static inject = ['http', 'hono', 'storage']

    lastRefreshDate: Date
    cache: Map<string, KoishiMarket.Object | null> = new Map()
    fetchTask: number = 0
    _queries = 0
    _nextSecond?: Promise<void>
    // httpAPI: HTTP // todo: use ctx.http.extend()
    // httpMeta: HTTP

    constructor(ctx: Context, protected options: Partial<KoishiRegistry.Config> = {}) {
        super(ctx, 'koishi')

        // this.options.endpoint = trimEnd(options.endpoint, '/')
        this.options.metaEndpoint = trimEnd(options.metaEndpoint, '/')
        this.options.apiEndpoint = trimEnd(options.apiEndpoint, '/')
        this.options.npmURL = trimEnd(options.npmURL, '/')
        this.lastRefreshDate = new Date()
        // this.httpAPI = ctx.http.extend({
        //
        // })

        ctx.on('npm/synchronized', () => this.quickRefresh())
    }

    override async start() {
        this.cache = new Map( // restore cache
            await this.readCache()
                .then(Object.entries)
        )
        if (this.cache.size) this.ctx.logger.info(`\trestored %C entries`, this.cache.size)
        this.ctx.on('dispose', () => this.writeCache())

        // when new plugin appears, update only the changed content
        this.ctx.on('npm/fetched-plugins', record => this.partialUpdate(record))

        this.ctx.hono.on("GET", ['/', '/index.json'], async (c) => {
            const result = await this.getObjects()
            return c.json({
                time: this.lastRefreshDate.toUTCString(),
                version: 1, // remove this will cause Koishi client to fetch npm again
                objects: result,
                synchronized: this.isSynchronized(),
                features: this.getFeatures()
            } satisfies KoishiMarket.Result & { synchronized: boolean, features: Dict<boolean, Feature> })
        })

        this.ctx.on('koishi/is-verified', (packageName) => packageName.startsWith('@koishijs/plugin-'))
        this.ctx.on('koishi/is-insecure', (_, manifest) => !!manifest.insecure)

        if (!this.ctx.root.get('timer'))
            this.ctx.logger.warn('timer service not found, could not do scheduled refresh')
        this.ctx.inject(['timer'], (ctx: Context) => {
            ctx.setInterval(() => this.quickRefresh(), this.options.autoRefreshInterval! * 1000)
        })
    }

    public getFeatures(): Dict<boolean, Feature> {
        return {
            scope: false,
            downloads: false,
            rating: false,
            score: false,
            package: true,
            manifest: true,
            verified: true,
            insecure: false
        }
    }

    updateRefreshDate() {
        this.lastRefreshDate = new Date()
    }

    // deno-lint-ignore require-await
    async getObjects(): Promise<KoishiMarket.Object[]> {
        return Array.from(this.cache.values().filter(x=>!!x))
    }

    isSynchronized(): boolean { // if all fetches are done, and npm changes is synchronized, then it is real synchronized
        return this.fetchTask === 0 && !!this.ctx.get('npm')?.synchronized
    }

    async isVerified(packageName: string, manifest: KoishiMarket.Manifest, meta?: NpmRegistry.Result): Promise<boolean> {
        return !!(await this.ctx.serial('koishi/is-verified', packageName, manifest, meta));
    }

    async isInsecure(packageName: string, manifest: KoishiMarket.Manifest, meta?: NpmRegistry.Result): Promise<boolean> {
        return !!(await this.ctx.serial('koishi/is-insecure', packageName, manifest, meta));
    }

    async scheduleNextTime() { // fuck npm, fuck npm, fuck npm!!!
        this._queries++
        if (this._queries > this.options.queryPerSecond!) {
            if (!this._nextSecond) {
                await (this._nextSecond = new Promise((resolve, reject) => {
                    if (!this.ctx.root.get('timer')) {
                        this.ctx.logger.warn('timer service not found, could not reschedule queries')
                        reject("timer service not available")
                    }
                    this.ctx.setTimeout(() => {
                        this._queries = 0
                        resolve()
                        this._nextSecond = undefined
                    }, 1000)
                }))
                await this.scheduleNextTime()
            } else { // reschedule after a second
                await this._nextSecond
                await this.scheduleNextTime()
            }
        }
    }

    static isCompatible(range: string, remote: Pick<RemotePackage, 'peerDependencies'>) {
        const { peerDependencies = {} } = remote
        const declaredVersion = peerDependencies['koishi']
        try {
            return declaredVersion && rangeIntersects(parseRange(range), parseRange(declaredVersion))
        } catch {
            return false
        }
    }

    private async _fresh_fetch(packageName: string): Promise<KoishiMarket.Object | null> {
        let metaResponse: HTTP.Response<NpmRegistry.Result>
        // let downloadsResponse: HTTP.Response<NpmRegistry.DownloadAPIResult>

        await this.scheduleNextTime()

        while (true) { // this part is so complex, that's all because npm removed the _bulk_get api
            // metaResponse = await Promise.all([
            metaResponse = await this.ctx.http<NpmRegistry.Result>(`${this.options.metaEndpoint}/${packageName}`, {
                        validateStatus: (status) => status === 200 || status === 404 || status === 429
            })
                // this.ctx.http<NpmRegistry.DownloadAPIResult>(
                //     `${this.options.apiEndpoint}/downloads/range/last-month/${packageName}`, {
                //         validateStatus: (status) => status === 200 || status === 404 || status === 429
                //     }
                // ),
            // ])

            const responses = [metaResponse]
            if (responses.every(r => r.status === 200)) break
            if (metaResponse.status === 404)
                return null
            if (responses.find(r => r.status === 429)) {
                this.ctx.logger.debug(`🟡 ${aligned(packageName)} \t\t| rate limited`)
                await this.scheduleNextTime()
            }
        }

        const [pack, downloads] = [metaResponse.data, { downloads: null }]

        if (!pack?.versions) throw new Error("Package have no versions")

        const convertUser = (user: NpmRegistry.User | string): KoishiMarket.User => {
            if (typeof user === 'string') {
                const matches = user.match(/^([\w-_.]+) ?<(.*)>$/)
                if (matches === null) return {
                    name: user,
                    username: user,
                    email: null!
                }
                else return {
                    name: matches.at(0),
                    username: matches.at(0),
                    email: matches.at(1)!
                }
            }
            user = structuredClone(user)
            if (!user.username) user.username = 'koishi'
            return user
        }

        const compatibles = Object.values(pack.versions).filter((remote) => {
            return KoishiRegistry.isCompatible('4', remote)
        }).sort((a, b) => compare(parse(a.version), parse(b.version)))

        const times = compatibles.map(item => pack.time[item.version]).sort()
        if (compatibles.length === 0) return null
        const meta = compatibles[compatibles.length - 1]
        const latest = compatibles[compatibles.length - 1]

        const links: KoishiMarket.Links = {
            npm: `${this.options.npmURL}/${packageName}`
        }

        if (pack?.bugs?.url)
            links.bugs = pack.bugs.url
        if (pack?.homepage)
            links.homepage = pack.homepage
        if (pack?.repository?.url)
            links.repository = pack.repository.url

        const manifest: KoishiMarket.Manifest = {
            hidden: Ensure.boolean(meta.koishi?.hidden),
            preview: Ensure.boolean(meta.koishi?.preview),
            insecure: Ensure.boolean(meta.koishi?.insecure),
            browser: Ensure.boolean(meta.koishi?.browser),
            category: Ensure.string(meta.koishi?.category),
            public: Ensure.array(meta.koishi?.public),
            description: Ensure.dict(meta.koishi?.description) || Ensure.string(meta.description, ''),
            locales: Ensure.array(meta.koishi?.locales, []),
            service: {
                required: Ensure.array(meta.koishi?.service?.required, []),
                optional: Ensure.array(meta.koishi?.service?.optional, []),
                implements: Ensure.array(meta.koishi?.service?.implements, []),
            }
        }

        if (typeof manifest.description === 'string') {
            manifest.description = manifest.description.slice(0, 1024)
        } else if (manifest.description) {
            for (const key in manifest.description) {
                manifest.description[key] = manifest.description[key].slice(0, 1024)
            }
        }

        meta.keywords = Ensure.array(meta.keywords, []).filter((keyword) => {
            if (!keyword.includes(':')) return true
            if (keyword === 'market:hidden') {
                manifest.hidden = true
            } else if (keyword.startsWith('required:')) {
                manifest.service.required.push(keyword.slice(9))
            } else if (keyword.startsWith('optional:')) {
                manifest.service.optional.push(keyword.slice(9))
            } else if (keyword.startsWith('impl:')) {
                manifest.service.implements.push(keyword.slice(5))
            } else if (keyword.startsWith('locale:')) {
                manifest.locales.push(keyword.slice(7))
            }
        })

        const shortname = shortnameOf(packageName)

        const [verified, insecure] = await Promise.all([
            this.isVerified(packageName, manifest, pack),
            this.isInsecure(packageName, manifest, pack)
        ])

        return {
            downloads: { lastMonth: downloads.downloads! },
            dependents: 0,
            category: 'other', // todo
            shortname: shortname,
            createdAt: times[0],
            updatedAt: times[times.length - 1],
            updated: pack.time.modified,
            rating: verified ? 5 : (insecure ? 0 : 1),
            verified: verified,
            insecure: insecure,
            portable: !!(meta.koishi?.browser),
            package: {
                name: packageName,
                keywords: (meta.keywords ?? [])
                    .map(keyword => keyword.toLowerCase())
                    .filter((keyword) => {
                        return !keyword.includes(':')
                            && !shortname.includes(keyword)
                            && !stopWords.some(word => keyword.includes(word))
                    }),
                version: latest.version,
                description: meta.description,
                // publisher: latestMeta['_npmUser'],
                publisher: convertUser(pack.maintainers[0]),
                maintainers: pack.maintainers.map(convertUser),
                license: pack.license,
                date: pack.time[latest.version],
                links: links,
                contributors: meta.author ? [convertUser(meta.author)] : []
            },
            flags: {
                insecure: 0
            },
            manifest: manifest,
            publishSize: meta.dist.unpackedSize,
        } satisfies KoishiMarket.Object
    }

    // fetch a package from scratch
    public async fresh_fetch(packageName: string): Promise<KoishiMarket.Object | null> {
        this.fetchTask++
        try {
            this.ctx.logger.debug(`🟡 ${aligned(packageName)} \t\t| fetching`)

            const object = await this._fresh_fetch(packageName)
            this.cache.set(packageName, object)
            this.writeCache()
            if (object === null) return null

            this.ctx.logger.debug(`✅ ${aligned(packageName)} \t\t| complete`)

            return object
        // deno-lint-ignore no-explicit-any
        } catch (e: any | Error) {
            if (e?.message === 'Package have no versions') {
                this.cache.set(packageName, null)
                this.writeCache()
                this.ctx.logger.debug(`⭕ ${aligned(packageName)} \t\t| no version`)
            }
            else {
                this.ctx.logger.warn(`⚠️ ${aligned(packageName)} \t\t|`)
                this.ctx.logger.warn(e)
            }
            return null
        } finally {
            this.fetchTask--
        }
    }

    // fetch a packageName (must be a koishi plugin)
    // prefer cached result
    public async fetch(packageName: string): Promise<KoishiMarket.Object | null> {
        const object = this.cache.get(packageName)
        if (typeof object === 'undefined') return await this.fresh_fetch(packageName)
        return object
    }

    private async partialUpdate(record: ChangeRecord[]) { // update the package of each provided records
        this.updateRefreshDate()

        await Promise.all(record.map(record => this.fresh_fetch(record.id)))
    }


    // Refresh downloads, (todo: rating)
    public async quickRefresh() {
        this.lastRefreshDate = new Date()
        this.ctx.logger.debug('triggered quickRefresh')

        await Promise.all(this.cache.entries().filter(([_, object])=>!!object).map(async ([packageName, object]) => {
            // await this.scheduleNextTime()

            const [verified, insecure] = await Promise.all([
                // this.ctx.http<NpmRegistry.DownloadAPIResult>(
                //     `${this.options.apiEndpoint}/downloads/range/last-month/${packageName}`, {
                //         validateStatus: (status) => status === 200 || status === 404 || status === 429
                //     }
                // ),
                this.isVerified(packageName, object!.manifest),
                this.isInsecure(packageName, object!.manifest),
            ])
            // if (downloadsResult.status === 404) // skip if not found
            //     return
            //
            // if (downloadsResult.status === 429) // skip if rate limited
            //     return
            //
            // const downloads = downloadsResult.data

            object!.verified = verified
            object!.insecure = insecure
            // temporary rating
            // verified: 5
            // insecure: 0
            // other:    1
            object!.rating = verified ? 5 : (insecure ? 0 : 1)
            // object.downloads.lastMonth = downloads.downloads
        }))
    }

    public writeCache() { // writeCache operation is debounced
        const self = this.writeCache as { _debounce?: boolean }
        if (self?._debounce) return
        self._debounce = true
        this.ctx.setTimeout(async () => {
            // this.ctx.logger.debug('-------- write cache')
            await this.ctx.storage.set("koishi.registry.cache", Object.fromEntries(this.cache.entries()))
            // const buf = Buffer.from(BSON.serialize({
            //     objects: Array.from(this.cache.values())
            // }))
            // await this.ctx.storage.setRaw("koishi.registry.cache", buf.toString('base64'))
            self._debounce = false
        }, 200)
    }

    public async readCache(): Promise<Dict<KoishiMarket.Object | null>> {
        if (await this.ctx.info.isUpdated) return Object.create(null)
        try {
            const data = await this.ctx.storage.get<Dict<KoishiMarket.Object | null>>("koishi.registry.cache")
            if (data === null) return Object.create(data)
            return data
        } catch {
            return Object.create(null)
        }
        // return BSON.deserialize(Buffer.from(dataStr, 'base64'))['objects'] as KoishiMarket.Object[]
    }
}

export namespace KoishiRegistry {
    export interface Config {
        metaEndpoint: string,
        apiEndpoint: string,
        npmURL: string,
        autoRefreshInterval: number,
        queryPerSecond: number
    }

    export const Config: Schema = Schema.object({
        metaEndpoint: Schema.string().default("https://registry.npmjs.org"),
        apiEndpoint: Schema.string().default("https://api.npmjs.org/"),
        npmURL: Schema.string().default("https://www.npmjs.com/"),
        autoRefreshInterval: Schema.number().min(30).default(600).description("Unit: seconds"),
        queryPerSecond: Schema
            .number()
            .min(0)
            .max(1000)
            .default(20)
            .description("Query Per Second: Limiting queries can be sent to `metaEndpoint` and `apiEndpoint`, 0 for no limit")
    })
}

export class NpmProvider extends Service {
    static inject = ['koishi', 'npm']

    constructor(ctx: Context) {
        super(ctx, 'koishi.npm');
    }

    override async start() {
        await this.fetch_uncached_from_npm()
    }

    public async refresh_all_from_npm(): Promise<KoishiMarket.Object[]> {
        this.ctx.koishi.updateRefreshDate()

        return (await Promise.all(
            this.ctx.npm.plugins
                .values()
                .map(packageName => this.ctx.koishi.fresh_fetch(packageName))
        )).filter(x => x !== null)
    }

    async fetch_uncached_from_npm(): Promise<KoishiMarket.Object[]> {
        // update those exist in ctx.npm.plugins, but not in our cache
        return (await Promise.all(this.ctx.npm.plugins
            .values()
            .filter(packageName => !this.ctx.koishi.cache.has(packageName))
            .map(packageName => this.ctx.koishi.fresh_fetch(packageName))
        )).filter(x => x !== null)
    }

}

export function apply(ctx: Context, config: KoishiRegistry.Config) {
    ctx.plugin(KoishiRegistry, config)
    ctx.inject(['npm'], (ctx) => {
        ctx.plugin(NpmProvider)
    })
}
