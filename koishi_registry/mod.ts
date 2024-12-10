import { Context, Service } from '../context.ts'
import Schema from 'schemastery'
import trimEnd from 'lodash.trimend'
import { Awaitable } from 'cosmokit'
import { ChangeRecord } from "../npm.ts";
import HTTP from "@cordisjs/plugin-http";
import type { KoishiMarket, NpmRegistry } from "./types.ts";
// import { ObjectList } from "./serializing.ts"; // whatevers, avsc doesn't work with my prefect Schema ;(
import { BSON } from 'bson'
import { Buffer } from "node:buffer";

export function aligned(s: string, pad = 35): string {
    if (s.length > pad)
        return s.substring(0, pad - 3) + '...'
    return s.padEnd(pad, ' ')
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
    static inject = ['npm', 'http', 'hono', 'storage']

    lastRefreshDate: Date
    cache: Map<string, KoishiMarket.Object> = new Map()
    fetchTask: number = 0
    _queries = 0
    _nextSecond?: Promise<void>

    constructor(ctx: Context, protected options: Partial<KoishiRegistry.Config>) {
        super(ctx, 'koishi')

        // this.options.endpoint = trimEnd(options.endpoint, '/')
        this.options.metaEndpoint = trimEnd(options.metaEndpoint, '/')
        this.options.apiEndpoint = trimEnd(options.apiEndpoint, '/')
        this.options.npmURL = trimEnd(options.npmURL, '/')
        this.lastRefreshDate = new Date()

        ctx.on('npm/synchronized', () => this.synchronized())
    }

    override async start() {
        this.ctx.logger.info("registry started")
        this.cache = new Map( // restore cache
            await this.readCache()
                .then(x => x.map(o => [o.package.name, o] as const))
        )
        this.ctx.logger.info(`restored %C entries`, this.cache.size)
        this.ctx.on('dispose', () => this.writeCache())

        this.ctx.on('npm/fetched-plugins', record => this.partialUpdate(record))

        this.ctx.hono.on("GET", ['/', '/index.json'], async (c) => {
            const result = await this.getObjects()
            return c.json({
                time: this.lastRefreshDate.toUTCString(),
                objects: result,
                synchronized: this.isSynchronized()
            } satisfies KoishiMarket.Result & { synchronized: boolean })
        })

        await this.update_uncached()
        if (!this.ctx.root.get('timer'))
            this.ctx.logger.warn('timer service not found, could not do scheduled refresh')
        this.ctx.inject(['timer'], (ctx: Context) => {
            ctx.setInterval(() => this.quickRefresh(), this.options.autoRefreshInterval! * 1000)
        })
    }

    // deno-lint-ignore require-await
    async getObjects(): Promise<KoishiMarket.Object[]> {
        return Array.from(this.cache.values())
    }

    isSynchronized(): boolean {
        return this.fetchTask === 0 && this.ctx.npm.synchronized
    }

    shortnameOf(name: string) {
        if (name.startsWith('@koishijs/plugin-')) return name.substring('@koishijs/plugin-'.length)
        const matches = name.match(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?koishi-plugin-([a-z0-9-._~])*$/)
        if (matches !== null) return matches[1]
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

    private async _fresh_fetch(packageName: string): Promise<KoishiMarket.Object | null> {
        let metaResponse: HTTP.Response<NpmRegistry.Result>
        let downloadsResponse: HTTP.Response<NpmRegistry.DownloadAPIResult>

        await this.scheduleNextTime()

        while (true) { // this part is so complex, that's all because npm removed the _bulk_get api
            [metaResponse, downloadsResponse] = await Promise.all([
                this.ctx.http<NpmRegistry.Result>(
                    `${this.options.metaEndpoint}/${packageName}`, {
                        validateStatus: (status) => status === 200 || status === 404 || status === 429
                    }
                ),
                this.ctx.http<NpmRegistry.DownloadAPIResult>(
                    `${this.options.apiEndpoint}/downloads/point/last-month/${packageName}`, {
                        validateStatus: (status) => status === 200 || status === 404 || status === 429
                    }
                ),
            ])

            const responses = [metaResponse, downloadsResponse]
            if (responses.every(r => r.status === 200)) break
            if (metaResponse.status === 404 || downloadsResponse.status === 404)
                return null
            if (responses.find(r => r.status === 429))
                await this.scheduleNextTime()
        }

        const [meta, downloads] = [metaResponse.data, downloadsResponse.data]

        if (!meta?.['dist-tags']?.['latest']) throw new Error("Could not find latest version")
        const latestVersion = meta?.["dist-tags"]?.['latest']
        const latestMeta = meta.versions[latestVersion]

        const links: KoishiMarket.Links = {
            npm: `${this.options.npmURL}/${packageName}`
        }

        if (meta?.bugs?.url)
            links.bugs = meta.bugs.url
        if (meta?.homepage)
            links.homepage = meta.homepage
        if (meta?.repository?.url)
            links.repository = meta.repository.url

        const manifest: KoishiMarket.Manifest = {
            public: [/* TODO */],
            service: {
                required: latestMeta?.koishi?.service?.required ?? [],
                optional: latestMeta?.koishi?.service?.optional ?? [],
                implements: latestMeta?.koishi?.service?.implements ?? [],
            },
            locales: latestMeta?.koishi?.locales ?? [],
            description: latestMeta?.koishi?.description ?? latestMeta.description,
        }

        return {
            downloads: { lastMonth: downloads.downloads },
            dependents: 0,
            category: 'other', // todo
            shortname: this.shortnameOf(packageName)!,
            createdAt: meta.time.created,
            updatedAt: meta.time.modified,
            updated: meta.time.modified,
            verified: await this.isVerified(packageName, manifest, meta),
            insecure: await this.isInsecure(packageName, manifest, meta),
            portable: !!(latestMeta.koishi?.browser),
            package: {
                name: packageName,
                keywords: meta.keywords,
                version: latestVersion,
                description: latestMeta.description,
                // publisher: latestMeta['_npmUser'],
                publisher: meta.maintainers[0],
                maintainers: meta.maintainers,
                license: meta.license,
                date: meta.time[latestVersion],
                links: links,
                contributors: []
            },
            flags: {
                insecure: 0
            },
            manifest: manifest,
            publishSize: latestMeta.dist.unpackedSize,
        } satisfies KoishiMarket.Object
    }

    // fetch a package from scratch
    async fresh_fetch(packageName: string): Promise<KoishiMarket.Object | null> {
        this.fetchTask++
        try {
            this.ctx.logger.debug(`🟡 ${aligned(packageName)} \t\t| fetching`)

            const object = await this._fresh_fetch(packageName)
            if (object === null) return null
            this.cache.set(packageName, object)
            this.writeCache()

            this.ctx.logger.debug(`✅ ${aligned(packageName)} \t\t| complete`)

            return object
        // deno-lint-ignore no-explicit-any
        } catch (e: any | Error) {
            if (e?.message === 'Could not find latest version')
                this.ctx.logger.debug(`🔴 ${aligned(packageName)} \t\t| no version`)
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
        if (typeof object === 'undefined' || object == null) return await this.fresh_fetch(packageName)
        return object
    }

    public async refresh_all(): Promise<KoishiMarket.Object[]> {
        this.lastRefreshDate = new Date()

        return (await Promise.all(
            this.ctx.npm.plugins
                .values()
                .map(packageName => this.fresh_fetch(packageName))
        )).filter(x => x !== null)
    }

    async update_uncached(): Promise<KoishiMarket.Object[]> {
        return (await Promise.all(this.ctx.npm.plugins
            .values()
            .filter(packageName => !this.cache.has(packageName))
            .map(packageName => this.fresh_fetch(packageName))
        )).filter(x => x !== null)
    }

    private async partialUpdate(record: ChangeRecord[]) {
        this.lastRefreshDate = new Date()

        await Promise.all(record.map(record => this.fresh_fetch(record.id)))
    }


    // Refresh downloads, (todo: rating)
    public async quickRefresh() {
        this.lastRefreshDate = new Date()
        this.ctx.logger.debug('triggered quickRefresh')

        await Promise.all(this.cache.entries().map(async ([packageName, object]) => {
            const [downloadsResult, isVerified, isInsecure] = await Promise.all([
                this.ctx.http<NpmRegistry.DownloadAPIResult>(
                    `${this.options.apiEndpoint}/downloads/last-month/${packageName}`, {
                        validateStatus: (status) => status === 200 || status === 404 || status === 429
                    }
                ),
                this.isVerified(packageName, object.manifest),
                this.isInsecure(packageName, object.manifest),
            ])
            if (downloadsResult.status === 404) { // invalidate the cache if not found
                this.cache.delete(packageName)
                this.writeCache()
                return
            }
            const downloads = downloadsResult.data

            object.verified = isVerified
            object.insecure = isInsecure
            object.downloads.lastMonth = downloads.downloads
        }))
    }

    public writeCache() { // writeCache operation is debounced
        const self = this.writeCache as { _debounce?: boolean }
        if (self?._debounce) return
        self._debounce = true
        this.ctx.setTimeout(async () => {
            // this.ctx.logger.debug('-------- write cache')
            const buf = Buffer.from(BSON.serialize({
                objects: Array.from(this.cache.values())
            }))
            await this.ctx.storage.setRaw("koishi.registry.cache", buf.toString('base64'))
            self._debounce = false
        }, 200)
    }

    public async readCache(): Promise<KoishiMarket.Object[]> {
        const dataStr = await this.ctx.storage.getRaw("koishi.registry.cache")
        if (dataStr === null) return []
        return BSON.deserialize(Buffer.from(dataStr, 'base64'))['objects'] as KoishiMarket.Object[]
    }

    async synchronized() {
        await this.quickRefresh()
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
            .default(30)
            .description("Query Per Second: Limiting queries can be sent to `metaEndpoint` and `apiEndpoint`, 0 for no limit")
    })
}

export default KoishiRegistry
