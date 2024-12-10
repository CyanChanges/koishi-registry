import { Context } from '../context.ts'
import { Storage } from './base.ts'

declare module 'cordis' {
    interface Context {
        'storage.localstorage': StorageLocalStorage
    }
}

export class StorageLocalStorage extends Storage {
    constructor(ctx: Context) {
        super(ctx, 'localstorage');
    }

    override has(key: string): boolean {
        return key in localStorage && typeof localStorage.getItem(key) === "string"
    }

    override getRaw(key: string): string | null {
        return localStorage.getItem(key);
    }

    override setRaw(key: string, value: string): void {
        localStorage.setItem(key, value)
    }

    override remove(key: string): void {
        localStorage.removeItem(key)
    }

    protected override clear(): void {
        localStorage.clear()
    }
}

export default StorageLocalStorage;
