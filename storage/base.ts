import { Context, Service } from "../context.ts";
import { Awaitable } from "cosmokit";

declare module 'cordis' {
    export interface Context {
        storage: Storage;
    }
}

export abstract class Storage extends Service {
    protected constructor(ctx: Context, name: string) {
        super(ctx, 'storage', true);
        ctx.set(`storage.${name}`, this)
    }

    abstract has(key: string): Awaitable<boolean>;
    async get<T>(key: string): Promise<T | null> {
        const string = await this.getRaw(key)
        if (string !== null) return JSON.parse(string)
        return null
    }
    async set<T>(key: string, value: T): Promise<void> {
        await this.setRaw(key, JSON.stringify(value))
    };
    abstract remove(key: string): Awaitable<void>;
    abstract setRaw(key: string, value: string): Awaitable<void>;
    abstract getRaw(key: string): Awaitable<string | null>;
    protected abstract clear(): Awaitable<void>;
}

export default Storage;
