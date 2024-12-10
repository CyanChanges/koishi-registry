import { Context, Service } from './context.ts'
import Schema from 'schemastery'
import trimEnd from 'lodash.trimend'
import { Awaitable, Dict } from 'cosmokit'
import { Registry as RegistryResult } from '@koishijs/registry'
import { RemotePackage } from "npm:@koishijs/registry@7.0.3";
import { ChangeRecord } from "./npm.ts";

export namespace KoishiRegistry {
    export interface Result {
        time: string,
        version?: number,
        objects: Object[]
    }

    export interface Object {
        downloads: { lastMonth: number }
        dependents: number
        updated: string
        package: Package
        // score: Score
        score?: Score
        flags: Flags
        shortname: string
        verified: boolean
        manifest: Manifest
        insecure: boolean
        category: string
        createdAt: string
        updatedAt: string
        // rating: number
        rating?: number
        portable: boolean
        // installSize: number
        installSize?: number
        publishSize: number
    }

    export interface Package {
        name: string
        keywords: string[]
        version: string
        description: string
        publisher: NpmRegistry.User
        maintainers: NpmRegistry.User[]
        license: string
        date: string
        links: Links
        contributors: NpmRegistry.User[]
    }

    export interface Links {
        homepage?: string
        repository?: string
        npm: string
        bugs?: string
    }

    export interface Score {
        final: number
    }

    export interface Flags {
        insecure: number
    }

    export interface Manifest {
        public: string[]
        description: string | Description
        locales: string[]
        service: Service
    }

    export interface Description {
        [lang: string]: string
    }

    export interface Service {
        required: string[]
        optional: string[]
        implements: string[]
    }
}

export function aligned(s: string, pad = 35): string {
    if (s.length > pad)
        return s.substring(0, pad - 3) + '...'
    return s.padEnd(pad, ' ')
}

export namespace NpmRegistry {
    export interface User {
        name?: string
        email: string
        url?: string
        username?: string
    }

    export interface VersionMeta extends RemotePackage {
        _npmUser: User
    }

    export interface Result extends RegistryResult {
        _id: string,
        _rev: string,
        'dist-tags': Dict<string, string>,
        maintainers: User[],
        keywords: string[],
        versions: Dict<VersionMeta>,
        bugs?: { url?: string },
        homepage?: string,
        repository?: { type?: string, url?: string },
        koishi: KoishiRegistry.Manifest,
        revs?: string[],
    }

    export interface DownloadAPIResult {
        downloads: number,
        start: string,
        end: string,
        package: string
    }

    export interface ErrorInfo {
        error: string
    }
}

declare module 'cordis' {
    export interface Context {
        koishi: KoishiRegistry
    }

    export interface Events {
        'koishi/is-verified'(packageName: string, manifest: KoishiRegistry.Manifest, meta?: NpmRegistry.Result): Awaitable<boolean | void>

        'koishi/is-insecure'(packageName: string, manifest: KoishiRegistry.Manifest, meta?: NpmRegistry.Result): Awaitable<boolean | void>
    }
}

export class KoishiRegistry extends Service {
    static inject = ['npm', 'http', 'hono']

    lastRefreshDate: Date
    cache: Map<string, KoishiRegistry.Object> = new Map()
    fetchTask: number = 0

    constructor(ctx: Context, protected options: KoishiRegistry.Config) {
        super(ctx, 'koishi')

        // this.options.registryEndpoint = trimEnd(options.registryEndpoint, '/')
        // this.options.apiEndpoint = trimEnd(options.apiEndpoint, '/')
        this.options.endpoint = trimEnd(options.endpoint, '/')
        this.options.npmURL = trimEnd(options.npmURL, '/')
        this.lastRefreshDate = new Date()

        ctx.on('npm/synchronized', () => this.synchronized())
    }

    override async start() {
        this.ctx.logger.info("registry started")
        this.ctx.on('npm/fetched-plugins', record => this.partialUpdate(record))

        this.ctx.hono.on("GET", ['/', '/index.json'], async (c) => {
            const result = await this.getObjects()
            return c.json({
                time: this.lastRefreshDate.toUTCString(),
                objects: result,
                synchronized: this.isSynchronized()
            } satisfies KoishiRegistry.Result & { synchronized: boolean })
        })

        await this.refresh_all()
        if (!this.ctx.root.get('timer'))
            this.ctx.logger.warn('timer service not found, could not do scheduled refresh')
        this.ctx.inject(['timer'], (ctx: Context) => {
            ctx.setInterval(()=>this.quickRefresh(), this.options.autoRefreshInterval * 1000)
        })
    }

    // deno-lint-ignore require-await
    async getObjects(): Promise<KoishiRegistry.Object[]> {
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

    async isVerified(packageName: string, manifest: KoishiRegistry.Manifest, meta?: NpmRegistry.Result): Promise<boolean> {
        return !!(await this.ctx.serial('koishi/is-verified', packageName, manifest, meta));
    }

    async isInsecure(packageName: string, manifest: KoishiRegistry.Manifest, meta?: NpmRegistry.Result): Promise<boolean> {
        return !!(await this.ctx.serial('koishi/is-insecure', packageName, manifest, meta));
    }

    private async _fresh_fetch(packageName: string): Promise<KoishiRegistry.Object> {
        let [metaResponse, downloadsResponse] = await Promise.all([
            this.ctx.http<NpmRegistry.Result>(
                `${this.ctx.npm.options.endpoint}/${packageName}`, {
                    validateStatus: (status) => status === 200 || status === 404
                }
            ),
            this.ctx.http<NpmRegistry.DownloadAPIResult>(
                `${this.options.endpoint}/downloads/point/last-month/${packageName}`, {
                    validateStatus: (status) => status === 200 || status === 404
                }
            ),
        ])

        if (metaResponse.status === 404 || downloadsResponse.status === 404)
            throw new Error("Package not found")

        const [meta, downloads] = [metaResponse.data, downloadsResponse.data]


        const latestVersion = meta["dist-tags"]['latest']
        const latestMeta = meta.versions[latestVersion]

        const links: KoishiRegistry.Links = {
            npm: `${this.options.npmURL}/${packageName}`
        }

        if (meta?.bugs?.url)
            links.bugs = meta.bugs.url
        if (meta?.homepage)
            links.homepage = meta.homepage
        if (meta?.repository?.url)
            links.repository = meta.repository.url

        const manifest: KoishiRegistry.Manifest = {
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
        } satisfies KoishiRegistry.Object
    }

    // fetch a package from scratch
    async fresh_fetch(packageName: string): Promise<KoishiRegistry.Object | null> {
        this.fetchTask++

        this.ctx.logger.debug(`🟡 ${aligned(packageName)} \t\t| fetching`)
        try {
            const object = await this._fresh_fetch(packageName)
            this.cache.set(packageName, object)
            this.ctx.logger.debug(`✅ ${aligned(packageName)} \t\t| complete`)

            return object
        // deno-lint-ignore no-explicit-any
        } catch (e: any | Error) {
            if (e?.message === 'Package not exist')
                this.ctx.logger.debug(`❎ ${aligned(packageName)} \t\t| not exist`)
            else
                this.ctx.logger.warn(`⚠️ ${aligned(packageName)} \t\t| ${e}`)
            return null
        } finally {
            this.fetchTask--
        }
    }

    // fetch a packageName (must be a koishi plugin)
    // prefer cached result
    public async fetch(packageName: string): Promise<KoishiRegistry.Object | null> {
        const object = this.cache.get(packageName)
        if (typeof object === 'undefined' || object == null) return await this.fresh_fetch(packageName)
        return object
    }

    public async refresh_all(): Promise<KoishiRegistry.Object[]> {
        this.lastRefreshDate = new Date()

        return (await Promise.all( // FIXME: 429 Too Many Requests
            this.ctx.npm.plugins
                .values()
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
                    `${this.options.endpoint}/downloads/last-month/${packageName}`, {
                        validateStatus: (status) => status === 200 || status === 404
                    }
                ),
                this.isVerified(packageName, object.manifest),
                this.isInsecure(packageName, object.manifest),
            ])
            if (downloadsResult.status === 404) { // invalidate the cache if not found
                this.cache.delete(packageName)
                return
            }
            const downloads = downloadsResult.data

            object.verified = isVerified
            object.insecure = isInsecure
            object.downloads.lastMonth = downloads.downloads
        }))
    }

    async synchronized() {
        await this.quickRefresh()
    }
}

export namespace KoishiRegistry {
    export interface Config {
        endpoint: string,
        npmURL: string,
        autoRefreshInterval: number
    }

    export const Config: Schema = Schema.object({
        endpoint: Schema.string().default("https://api.npmjs.org/"),
        npmURL: Schema.string().default("https://www.npmjs.com/"),
        autoRefreshInterval: Schema.number().min(30).default(600).description("Unit: seconds")
    })
}

export default KoishiRegistry
