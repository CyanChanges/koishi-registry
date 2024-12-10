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
    abstract get(key: string): Awaitable<object | null>;
    abstract set(key: string, value: object): Awaitable<void>;
    abstract remove(key: string): Awaitable<void>;
    protected abstract clear(): Awaitable<void>;
}

export default Storage;
