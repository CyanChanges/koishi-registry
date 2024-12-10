import { Context, Service } from "./context.ts";
import trim from 'lodash.trim'
import trimEnd from 'lodash.trimend'
import Schema from "schemastery";
import type { Awaitable } from "cosmokit";

declare module 'cordis' {
    export interface Events {
        'npm/fetched-packages'(records: ChangeRecord[]): Awaitable<void>;
        'npm/fetched-plugins'(records: ChangeRecord[]): Awaitable<void>;
        'npm/synchronized'(): Awaitable<void>;
    }
}

declare module 'cordis' {
    export interface Context {
        npm: NpmWatcher
    }
}

export interface Change {
    rev: string
}

export interface ChangeRecord {
    seq: number
    id: string
    changes: Change[],
    deleted?: boolean
}

export interface Block {
    id: number,
    begin: number,
    end: number
}

export type BlockTask = Block & { done: boolean }

export function isKoishiPlugin(id: string): boolean {
    if (id.startsWith('@koishijs/plugin-')) return true
    if (!id.includes("koishi-plugin-")) return false
    return !!id.match(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?koishi-plugin-[a-z0-9-._~]*$/);
}

export class NpmWatcher extends Service {
    static inject = ['http', 'storage']

    fetchTask?: Promise<void>

    _seq = 8000000 // 2022-01(Koishi v4)
    plugins: Set<string> = new Set()
    synchronized = false

    get seq(): number {
        return this._seq
    }

    set seq(value: number) {
        this._seq = value
        this.ctx.storage.set("npm.seq", value)?.then?.()
    }

    constructor(ctx: Context, public options: NpmWatcher.Config) {
        super(ctx, 'npm');
        this.options.endpoint = trimEnd(this.options.endpoint, '/')
    }

    public async flushPlugins() {
        await this.ctx.storage.set("npm.plugins", [...this.plugins])
    }

    async handle(stream: ReadableStream<Uint8Array>, update?: (seq: number) => void, stop_at: number = 0): Promise<boolean> {
        const decoder = new TextDecoderStream("utf-8")
        const reader = stream.pipeThrough(decoder).getReader()
        while (this.ctx.scope.isActive) {
            let result: ReadableStreamReadResult<string>;
            try {
                result = await reader.read()
            } catch {
                return false
            }
            if (result.done) return true
            const data = result.value

            const records: ChangeRecord[] = data
                .split('\n')
                .map(data => trim(data, ','))
                .filter(Boolean)
                .flatMap(data => {
                    try { return [JSON.parse(data)] } catch { return [] }
                })

            if (records.length > 0) {
                const last = records[records.length - 1]
                await this.ctx.parallel(this, 'npm/fetched-packages', records)
                // this.ctx.logger.debug(`Fetched ${records.length} packages from ${this.options.endpoint}`)
                update?.(last.seq)
                if (stop_at > 0 && last.seq >= stop_at) return true
            }

            const filtered = records.filter(record=>isKoishiPlugin(record.id))

            if (filtered.length > 0) {
                await this.ctx.parallel(this, 'npm/fetched-plugins', filtered)
                this.ctx.logger.debug(`fetched ${filtered.length} plugins from ${this.options.endpoint}`)
                filtered.forEach(record => this.plugins.add(record.id))
                await this.flushPlugins()
                // console.log('-- data: ', filtered)
            }
        }
        return false
    }

    private async fetchSpan(begin: number, end: number, update?: (seq: number) => void) {
        while (this.ctx.scope.isActive) {
            let body: ReadableStream<Uint8Array>
            try {
                const response = await this.ctx.http(`${this.options.endpoint}/_changes?since=${begin}&seq_interval=${end - begin}`, {
                    responseType: (response) => response.body,
                })

                body = response.data
            } catch {
                continue
            }

            if (!await this.handle(body, update, end)) continue
            break
        }
    }

    private async simpleFetch() {
        // const response = await this.ctx.http(`https://replicate.npmjs.com/_changes?filter=_selector&since=${this.seq}`, {
        //     responseType: (response) => response.body,
        //     method: 'POST',
        //     data: {
        //         selector: { '_id': { $regex: '^.*koishi.*$' } }
        //     }
        // })

        while (this.ctx.scope.isActive) {
            let body: ReadableStream<Uint8Array>
            try {
                const response = await this.ctx.http(`${this.options.endpoint}/_changes?since=${this.seq}`, {
                    responseType: (response) => response.body,
                })

                body = response.data
            } catch {
                continue
            }

            await this.handle(body)
            break
        }
    }

    private async fetch() {
        const response = await this.ctx.http(`${this.options.endpoint}/`)
        const max_seq = response.data['committed_update_seq'] // get commited seq

        let blocks_till_sync = Math.ceil((max_seq - this.seq) / this.options.block_size)

        this.ctx.logger.info("start fetching with %c worker(s) (seq: %c)...", this.options.concurrent, this.seq)

        const block_queue = Array.from(
            { length: blocks_till_sync },
            (_, id) => ({
                id,
                begin: this.seq + this.options.block_size * id,
                end: this.seq + this.options.block_size * (id + 1) - 1
            })
        )
        const block_map: Map<number, BlockTask> = new Map(
            block_queue
                .map(x => [x.id, Object.assign(x, { done: false })])
        )

        const setComplete = (id: number) => {
            block_map.get(id)!.done = true
            let last_done_task = null
            for (const block_task of block_map.values()) {
                if (block_task.done) last_done_task = block_task
                else break
            }
            if (last_done_task !== null && last_done_task.end > this.seq )
                this.seq = last_done_task.end
        }

        const updateSeq = (id: number, seq: number) => {
            let last_done_task = null
            for (const block_task of block_map.values()) {
                if (block_task.done) last_done_task = block_task
                else break
            }
            if (last_done_task?.id === id - 1)
                this.seq = seq
        }

        const workers = Promise.all(Array.from(
            { length: this.options.concurrent },
            (_, i) => i
        ).map(async worker_id => {
            const logger = this.ctx.logger.extend(`worker-${worker_id}`)

            while (true) {
                const block = block_queue.shift()
                if (!block) break
                const { id, begin, end } = block

                logger.debug('\tfetching span %C ~ %C', begin, end)
                await this.fetchSpan(begin, end, seq => updateSeq(id, seq))
                setComplete(id)
                logger.debug('\tcomplete span %C ~ %C (remaining %C)', begin, end,
                    Array.from(block_map
                        .values()
                        .filter(x => !x.done)
                        .map(() => null)
                    ).length
                )

            }

            logger.debug('\tquitting')
        }))
        await workers
        this.ctx.logger.info('synchronized with npm')

        this.synchronized = true
        await this.ctx.parallel(this, "npm/synchronized")
        this.ctx.logger.debug('start synchronizing with npm (seq: %c)', this.seq)
        await this.simpleFetch() // Most records is synchronized, so we can just watch new changes here
    }

    override async start() {
        this.synchronized = false

        if (await this.ctx.storage.has('npm.seq')) {
            this.seq = await this.ctx.storage.get('npm.seq');
            this.ctx.logger.debug("restored seq %c", this.seq)
        }
        if (await this.ctx.storage.has('npm.plugins')) {
            this.plugins = new Set(await this.ctx.storage.get('npm.plugins'));
            this.ctx.logger.debug("restored %c plugin(s)", this.plugins.size)
        }

        this.fetchTask = this.fetch().catch(this.ctx.scope.cancel)
    }
}

// deno-lint-ignore no-namespace
export namespace NpmWatcher {
    export interface Config {
        endpoint: string,
        concurrent: number,
        block_size: number,
    }

    export const Config: Schema = Schema.object({
        endpoint: Schema.string().default('https://replicate.npmjs.com/'),
        concurrent: Schema.number().min(1).default(20),
        block_size: Schema.number().min(100).default(1000)
    })
}

export default NpmWatcher
