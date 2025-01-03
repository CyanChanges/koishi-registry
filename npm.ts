import { parse, parseRange, satisfies } from '@std/semver'
import { Context, Service } from "./context.ts";
import trim from 'lodash.trim'
import trimEnd from 'lodash.trimend'
import Schema from "schemastery";
import type { Awaitable, Dict } from "cosmokit";

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
    static inject = ['http']

    fetchTask?: Promise<void>

    _seq = 0 // Let's refresh from the peace (the Genshin Impact of Npm, which is begins at 0)
    plugins: Map<string, number> = new Map()
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
        await this.ctx.storage.set("npm.cache.plugins", Object.fromEntries(this.plugins.entries()))
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
                update?.(last.seq)
                this.ctx.parallel(this, 'npm/fetched-packages', records).then()
                if (stop_at > 0 && last.seq >= stop_at) return true
            }

            const filtered = records.filter(record=>isKoishiPlugin(record.id))

            if (filtered.length > 0) {
                this.ctx.logger.debug(`fetched ${filtered.length} plugins from ${this.options.endpoint}`)
                filtered.forEach(record => this.plugins.set(record.id, record.seq))
                await this.flushPlugins()
                this.ctx.parallel(this, 'npm/fetched-plugins', filtered).then()
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
        }
    }

    private async getMaxSeq(_times=0): Promise<number> {
        if (_times > this.options.max_retries) throw new Error("too many retries")
        const response = await this.ctx.http(`${this.options.endpoint}/`, {
            validateStatus(status) {
                return status === 200 || status === 429
            }
        })
        if (response.status === 200) return response.data['committed_update_seq'] as number
        return await this.getMaxSeq(_times + 1)
    }

    private async fetch() {
        const max_seq = await this.getMaxSeq()
        
        const blocks_till_sync = Math.ceil((max_seq - this.seq) / this.options.block_size)


        // work queue, all blocks waiting for being fetched
        const block_queue = Array.from(
            { length: blocks_till_sync },
            (_, id) => ({
                id,
                begin: this.seq + this.options.block_size * id,
                end: this.seq + this.options.block_size * (id + 1) - 1
            })
        )
        const block_map: Map<number, BlockTask> = new Map( // all blocks, for status tracking
            block_queue
                .map(x => [x.id, Object.assign(x, { done: false })])
        )

        const setComplete = (id: number) => { // set the status block with this `id` as completed
            block_map.get(id)!.done = true
            let last_done_task = null
            for (const block_task of block_map.values()) {
                if (block_task.done) last_done_task = block_task
                else break
            }
            if (last_done_task !== null && last_done_task.end > this.seq )
                this.seq = last_done_task.end
        }

        const updateSeq = (id: number, seq: number) => { // update the current seq of the block with this `id`
            let last_done_task = null
            for (const block_task of block_map.values()) {
                if (block_task.done) last_done_task = block_task
                else break
            }
            if (last_done_task?.id === id - 1)
                this.seq = seq
        }

        const workers = Promise.all(Array.from(
            { length: this.options.concurrent }, // create `this.options.concurrent` workers.
            (_, i) => i
        ).map(async worker_id => {
            const logger = this.ctx.logger.extend(`w-${worker_id}`)

            while (true) {
                const block = block_queue.shift()
                if (!block) break
                const { id, begin, end } = block

                logger.debug('\t%C ~ %C', begin, end)
                await this.fetchSpan(begin, end, seq => updateSeq(id, seq))
                setComplete(id)
                logger.debug('\t%C ~ %C (remaining %C)', begin, end,
                    Array.from(block_map
                        .values()
                        .filter(x => !x.done)
                        .map(() => null)
                    ).length
                )

            }
        }))
        await workers
        this.ctx.logger.info('synchronized with npm')

        this.synchronized = true
        await this.ctx.parallel(this, "npm/synchronized")

        await this.simpleFetch() 
    }

    override async start() {
        this.synchronized = false

        await this.ctx.info.checkTask
        if (!satisfies(this.ctx.info.previous ?? parse("0.0.1"), parseRange("^0.2.99"))) {
            this.ctx.storage.remove('npm.seq')
            this.ctx.storage.remove('npm.cache.plugins')
        }
        if (await this.ctx.storage.has('npm.seq'))
            this.seq = await this.ctx.storage.get('npm.seq') as unknown as number;
        
        if (await this.ctx.storage.has('npm.cache.plugins'))
            this.plugins = new Map(Object.entries((await this.ctx.storage.get<Dict<number>>('npm.cache.plugins'))!));
        


        this._startFetchTask()
    }

    private _startFetchTask() {
        this.fetchTask = this.fetch().catch(e => {
            this.ctx.logger.error(e)
            // this.ctx.scope.cancel(e) api disapr in cords v 4
        })
    }
}

// deno-lint-ignore no-namespace
export namespace NpmWatcher {
    export interface Config {
        endpoint: string,
        concurrent: number,
        block_size: number,
        max_retries: number
    }

    export const Config: Schema = Schema.object({
        endpoint: Schema.string().default('https://replicate.npmjs.com/'),
        concurrent: Schema.number().min(1).default(20),
        block_size: Schema.number().min(100).default(1000),
        max_retries: Schema.number().min(0).default(5)
    })
}

export default NpmWatcher
