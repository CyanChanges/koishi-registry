import { Context, Service } from '../context.ts'
import Schema from 'schemastery'
import trimEnd from 'lodash.trimend'
import { Awaitable, type Dict } from 'cosmokit'
import { compare, parse, parseRange, Range, rangeIntersects } from '@std/semver'
import { Ensure, type RemotePackage } from '@koishijs/registry'
import type { KoishiMarket, NpmRegistry } from "./types.ts";
import { Analyzer, Features, SimpleAnalyzer } from "../analyzer";
import CacheService, { Caches } from "../cache.ts";
import HTTP from "@cordisjs/plugin-http";
// import { ObjectList } from "./serializing.ts"; // whatevers, avsc doesn't work with my prefect Schema ;(
// import { BSON } from 'bson'
// import { Buffer } from "node:buffer";

export type { Feature, Features } from '../analyzer'

// const stopWords = [
//     'koishi',
//     'plugin',
//     'bot',
//     'coolq',
//     'cqhttp',
// ]

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
        koishi: RegistryGenerator
        'koishi.meta': KoishiMeta
    }

    export interface Events {
        'koishi/is-verified'(meta: NpmRegistry.Result): Awaitable<boolean | void>

        'koishi/is-insecure'(meta: NpmRegistry.Result): Awaitable<boolean | void>

        'koishi/before-refresh'(): void
    }
}

declare module '../cache.ts' {
    interface Caches {
        koishi: {
            registry: {
                [P: string]: NpmRegistry.Result | null;
            }
        }
    }
}

// meta cache layer
export class KoishiMeta {
    static inject = ['http', 'cache']

    _internal: Map<string, NpmRegistry.Result | null> = new Map()
    protected cache: CacheService<Caches['koishi']['registry']>
    fetch_tasks = 0
    _queries: number = 0;
    _next?: Promise<void>
    context: Context

    [Service.tracker] = {
        associate: 'koishi.meta',
        name: 'ctx'
    }

    get cached_size() {
        return this._internal.size
    }

    constructor(protected ctx: Context, public options: KoishiMeta.Config) {
        this.context = ctx
        this.cache = ctx.cache.extend('koishi.registry')
        ctx.set("koishi.meta", this)
        ctx.alias('koishi.meta', ['koishi.registry'])
    }

    private async _schedule(): Promise<void> {
        this._queries++
        if (this._queries > this.options.qps!) {
            if (!this._next) {
                await (this._next = new Promise((resolve, reject) => {
                    if (!this.context.root.get('timer')) {
                        this.context.logger.warn('timer service not found, could not reschedule queries')
                        reject("timer service not available")
                    }
                    this.context.setTimeout(() => {
                        this._queries = 0
                        resolve()
                        this._next = undefined
                    }, 1000)
                }))
                await this._schedule()
            } else { // reschedule after a second
                await this._next
                await this._schedule()
            }
        }
    }

    private async _query(name: string): Promise<NpmRegistry.OkResult | null> {
        let retries = this.options.retries
        const fetcher = async (): Promise<NpmRegistry.OkResult | null> => {
            if (!retries) throw new Error("rate limit retries exceeded")
            const response = await this.ctx.http<NpmRegistry.Result>(`${this.options.endpoint}/${name}`, {
                validateStatus: (status) => status === 200 || status === 404 || status === 429
            }).catch(e =>{
                if (HTTP.Error.is(e)) {
                    this.ctx.logger.debug(`🟡 ${aligned(name)} \t\t| error thrown`)
                    this.ctx.logger.debug(e)
                }
                return Promise.reject(e)
            })

            if (response.status === 200) return response.data
            if (response.status === 404) return null
            if (response.status === 429) {
                retries--
                this.ctx.logger.debug(`🟡 ${aligned(name)} \t\t| rate limited`)
                return await this._schedule().then(fetcher)
            }
            throw new Error("unreachable")
        }
        return await this._schedule().then(fetcher).catch(async e => {
            if (!HTTP.Error.is(e)) return Promise.reject(e)
            return await this._schedule().then(fetcher);
        })
    }

    async query(name: string, force: boolean = false): Promise<NpmRegistry.OkResult | null> {
        this.fetch_tasks++
        try {
            if (force || !await this.has(name)) {
                const meta = await this._query(name)
                await this.set(name, meta)
                return meta
            }
            return await this.get(name)!
        } finally {
            this.fetch_tasks--
        }
    }

    async get(name: string, clean: boolean = false): Promise<NpmRegistry.Result | null> {
        const result = this._internal.get(name)
        if (clean || typeof result === 'undefined') {
            const cached = await this.cache.get(name)
            if (typeof cached === 'object') {
                await this.set(name, cached)
                return cached
            } else
                return await this.query(name, true)
        }
        return result
    }

    async has(name: string): Promise<boolean> {
        return this._internal.has(name) || await this.cache.has(name)
    }

    async set(name: string, meta: NpmRegistry.Result | null): Promise<this> {
        this._internal.set(name, meta)
        await this.cache.set(name, meta)
        return this
    }

    async refetchOne(name: string): Promise<NpmRegistry.OkResult | null> {
        return await this.query(name)
    }
}

export namespace KoishiMeta {
    export interface Config {
        endpoint: string,
        qps: number,
        retries: number
    }

    export const Config: Schema<Config> = Schema.object({
        endpoint: Schema.string().default("https://registry.npmjs.org/"),
        retries: Schema.number().min(0).default(5),
        qps: Schema.number().min(1).default(30)
    })
}

export interface RegistryGenerator {
    analyzer: Analyzer
}

export class RegistryGenerator extends Service {
    static inject = ['http', 'koishi.analyzer', 'koishi.meta']

    declare meta: KoishiMeta
    last_refresh: Date = new Date()
    object_cache: Map<string, KoishiMarket.Object | null> = new Map()
    fetch_task: number = 0
    _queries = 0
    _next_second?: Promise<void>
    context: Context

    constructor(ctx: Context, protected options: Partial<RegistryGenerator.Config> = {}) {
        super(ctx, 'koishi')
        this.context = ctx

        // this.meta_cache = new MetaCache(this.ctx, {
        //     retries: this.options.rateLimitRetries!,
        //     endpoint: this.options.metaEndpoint!,
        //     qps: this.options.queryPerSecond!
        // })

        // this.options.endpoint = trimEnd(options.endpoint, '/')
        // this.options.metaEndpoint = trimEnd(options.metaEndpoint, '/')
        // this.options.apiEndpoint = trimEnd(options.apiEndpoint, '/')
        this.options.npmURL = trimEnd(options.npmURL, '/')
    }

    override async start() {
        // if (this.meta.cached_size) this.ctx.logger.info(`\trestored %C entries`, this.meta.cached_size)
        // this.ctx.on('dispose', () => this.saveCache())

        if (!this.ctx.root.get('timer'))
            this.ctx.logger.warn('timer service not found, could not do scheduled refresh')
        else
            this.ctx.inject(['timer'], (ctx) => {
                ctx.setInterval(() => ctx.koishi.refreshFast(), this.options.refreshInterval! * 1000)
            })
    }

    public getFeatures(): Features {
        const analyzer = this.analyzer.getFeatures()
        return {
            ...analyzer
        }
    }

    beforeRefresh() {
        this.context.emit("koishi/before-refresh")
        this.last_refresh = new Date()
    }

    // deno-lint-ignore require-await
    async getObjects(): Promise<KoishiMarket.Object[]> {
        return Array.from(this.object_cache.values().filter(x => !!x))
    }

    isSynchronized(): boolean { // if all fetches are done, and npm changes is synchronized, then it is real synchronized
        return this.fetch_task === 0 && !!this.context.get('npm')?.synchronized
    }

    static isCompatible(range: Range, remote: Pick<RemotePackage, 'peerDependencies'>) {
        const { peerDependencies = {} } = remote
        const declaredVersion = peerDependencies['koishi']
        try {
            return declaredVersion && rangeIntersects(range, parseRange(declaredVersion))
        } catch {
            return false
        }
    }

    private async _generateObject(packageName: string): Promise<KoishiMarket.Object | null> {
        const pack = await this.meta.get(packageName)

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
            if (!user.username) user.username = user.name ?? 'koishi'
            return user
        }

        if (!pack?.versions) throw new Error("Package have no version")

        const compatibles = Object.values(pack.versions).filter((remote) => {
            return RegistryGenerator.isCompatible(parseRange('4'), remote)
        }).sort((a, b) => compare(parse(a.version), parse(b.version)))

        const versions = compatibles.filter(pack => typeof pack.deprecated !== 'string')
        const times = versions.map(item => pack.time[item.version]).sort()
        if (versions.length === 0) throw new Error("Package have no version")
        const meta = versions[versions.length - 1]

        const links: Dict<string> = {
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

        const shortname = shortnameOf(packageName)

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

        const object = {
            category: 'other', // todo
            shortname: shortname,
            createdAt: times[0],
            updatedAt: times[times.length - 1],
            updated: pack.time.modified,
            portable: !!(meta.koishi?.browser),
            verified: false,
            score: { // placeholder
                final: 0,
                detail: {
                    quality: 0,
                    popularity: 0,
                    maintenance: 0
                }
            },
            rating: 0,
            license: pack.license,
            package: {
                name: packageName,
                keywords: meta.keywords,
                version: meta.version,
                description: meta.description,
                // publisher: latestMeta['_npmUser'],
                publisher: convertUser(pack.maintainers[0]),
                maintainers: pack.maintainers.map(convertUser),
                license: pack.license,
                date: pack.time[meta.version],
                links: links,
                contributors: meta.author ? [convertUser(meta.author)] : []
            },
            flags: {
                insecure: 0
            },
            manifest: manifest,
            publishSize: meta.dist.unpackedSize,
        } satisfies Partial<KoishiMarket.Object>

        await SimpleAnalyzer.prototype.analyzeAll.call(this.analyzer, {
            ctx: this.context,
            name: packageName,
            object,
            meta
        }) // SAFETY: SearchObject is complete after analyze call

        return object as KoishiMarket.Object
    }

    // generate market object from scratch
    public async generateObject(packageName: string): Promise<KoishiMarket.Object | null> {
        this.fetch_task++
        try {
            this.ctx.logger.debug(`🟡 ${aligned(packageName)} \t\t| fetching`)

            const object = await this._generateObject(packageName)
            this.object_cache.set(packageName, object)
            // this.saveCache()
            if (object === null) return null

            this.ctx.logger.debug(`✅ ${aligned(packageName)} \t\t| complete`)

            return object
        // deno-lint-ignore no-explicit-any
        } catch (e: any | Error) {
            if (e?.message === 'Package have no version') {
                this.object_cache.set(packageName, null)
                // this.saveCache()
                this.ctx.logger.debug(`⭕  ${aligned(packageName)} \t\t| no version`)
            }
            else {
                this.ctx.logger.warn(`⚠️ ${aligned(packageName)} \t\t|`)
                this.ctx.logger.warn(e)
            }
            return null
        } finally {
            this.fetch_task--
        }
    }

    // fetch market object for `packageName` (must be a koishi plugin)
    // prefer cached result
    public async fetchObject(packageName: string, regenerate: boolean = false, refresh_meta: boolean = false): Promise<KoishiMarket.Object | null> {
        if (regenerate) {
            if (refresh_meta) await this.meta.refetchOne(packageName)
            return await this.generateObject(packageName)
        }
        const object = this.object_cache.get(packageName)
        if (typeof object === 'undefined') return await this.generateObject(packageName)
        return object
    }

    // @deprecated: use `fetchObject()` instead
    public fetch(packageName: string, regenerate: boolean = false, refresh_meta: boolean = false): Promise<KoishiMarket.Object | null> {
        return this.fetchObject(packageName, regenerate, refresh_meta)
    }

    public async refreshPartially(names: string[]) { // update the package of each provided records
        this.beforeRefresh()

        await Promise.all(names.map(name => this.generateObject(name)))
    }

    // Refresh downloads, (todo: rating)
    public async refreshFast() {
        this.beforeRefresh()
        this.ctx.logger.debug('triggered quickRefresh')

        await Promise.all(this.object_cache.entries().filter(([_, object]) => !!object).map(async ([packageName, object]) => {
            if (!object) return
            const pack = await this.meta.get(packageName)
            if (!pack) {
                this.object_cache.delete(packageName)
                return
            }

            if (!pack?.versions) return

            const compatibles = Object.values(pack.versions).filter((remote) => {
                return RegistryGenerator.isCompatible(parseRange('4'), remote)
            }).sort((a, b) => compare(parse(a.version), parse(b.version)))

            const versions = compatibles.filter(pack => typeof pack.deprecated === 'string')
            if (versions.length === 0) return
            const meta = versions[versions.length - 1]

            await SimpleAnalyzer.prototype.analyzeAll.call(this.analyzer, {
                ctx: this.ctx,
                name: packageName,
                meta,
                object
            })
        }))
    }

    // public saveCache() { // writeCache operation is debounced
    //     const self = this.saveCache as { _debounce?: boolean }
    //     if (self?._debounce) return
    //     self._debounce = true
    //     this.ctx.setTimeout(async () => {
    //         // this.ctx.logger.debug('-------- write cache')
    //         await this.ctx.storage.set("koishi.registry.cache", Object.fromEntries(this.meta_cache.entries()))
    //         // const buf = Buffer.from(BSON.serialize({
    //         //     objects: Array.from(this.meta_cache.values())
    //         // }))
    //         // await this.ctx.storage.setRaw("koishi.registry.cache", buf.toString('base64'))
    //         self._debounce = false
    //     }, 200)
    // }

    // public async loadCache(): Promise<Dict<NpmRegistry.OkResult | null>> {
    //     if (await this.ctx.info.isUpdated) {
    //         if (
    //             await this.ctx.info.isDowngrade || // if downgrade
    //             ['major', 'premajor', 'minor', 'preminor'] // or if breaking changes
    //                 .includes(difference(this.ctx.info.version, this.ctx.info.previous!)!)
    //         ) // drop the cache
    //             return Object.create(null)
    //     }
    //     try {
    //         const data = await this.ctx.storage.get<Dict<NpmRegistry.OkResult | null>>("koishi.registry.cache")
    //         if (data === null) return Object.create(data)
    //         return data
    //     } catch {
    //         return Object.create(null)
    //     }
    //     // return BSON.deserialize(Buffer.from(dataStr, 'base64'))['objects'] as KoishiMarket.Object[]
    // }
}

export namespace RegistryGenerator {
    export interface Config {
        npmURL: string,
        refreshInterval: number
    }

    export const Config: Schema = Schema.object({
        npmURL: Schema.string().default("https://www.npmjs.com/"),
        refreshInterval: Schema.number().min(30).default(600).description("Unit: seconds"),
    })
}

export class NpmProvider extends Service {
    static inject = ['koishi', 'koishi.analyzer', 'koishi.meta', 'npm', 'storage']
    cache: Map<string, number> = new Map()

    constructor(ctx: Context) {
        super(ctx, 'koishi.npm');
    }

    override async start() {
        if (this.ctx.storage.has("koishi.npm.cache"))
            this.cache = new Map(Object.entries(this.ctx.storage.get<Dict<number>>("koishi.npm.cache")))

        this.ctx.on('dispose', () => this.saveCache())

        this.ctx.on('npm/synchronized', () => this.ctx.koishi.refreshFast())
        this.ctx.on('npm/fetched-plugins', record => Promise.all(
            record.map((rec) => this.ctx.koishi.fetch(rec.id, true, true))
        ).then())

        await this.fetchUncached()
        await this.refreshNpm()
    }

    public async refreshNpm(): Promise<void> {
        this.ctx.koishi.beforeRefresh()

        await Promise.all(
            this.ctx.npm.plugins
                .entries()
                .map(([packageName]) => this.ctx.koishi.fetch(packageName, true, false))
        )
    }

    async fetchUncached(): Promise<void> {
        this.ctx.koishi.beforeRefresh()
        // update those exist in ctx.npm.plugins, but not in our cache
        await Promise.all(this.ctx.npm.plugins
            .entries()
            .filter(([packageName, seq]) => this.cache.get(packageName) !== seq)
            .map(async ([packageName, seq]) => {
                await this.ctx.koishi.meta.refetchOne(packageName)
                this.cache.set(packageName, seq)
                this.saveCache()
            })
        )
    }

    saveCache() {
        const self = this.saveCache as { _debounce?: boolean }
        if (self?._debounce) return
        self._debounce = true
        this.ctx.setTimeout(async () => {
            // this.ctx.logger.debug('-------- write cache')
            await this.ctx.storage.set("koishi.npm.cache", Object.fromEntries(this.cache.entries()))
            // const buf = Buffer.from(BSON.serialize({
            //     objects: Array.from(this.cache.values())
            // }))
            // await this.ctx.storage.setRaw("koishi.npm.cache", buf.toString('base64'))
            self._debounce = false
        }, 200)
    }

}

export interface Config {
    registry: KoishiMeta.Config,
    generator: RegistryGenerator.Config
}

export const Config: Schema = Schema.intersect([Schema.object({
    registry: KoishiMeta.Config,
}).description("Meta provider"), Schema.object({
    generator: RegistryGenerator.Config
}).description("Registry generator")])

export function apply(ctx: Context, config: Config) {
    // if (!ctx.get('koishi.analyzer'))
    //     ctx.plugin(SimpleAnalyzer)
    ctx.plugin(RegistryGenerator, config.generator)
    ctx.plugin(KoishiMeta, config.registry)
    ctx.inject(['npm'], (ctx) => {
        ctx.plugin(NpmProvider)
    })
}
