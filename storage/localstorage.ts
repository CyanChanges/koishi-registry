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

    override get(key: string): object | null {

        const data = localStorage.getItem(key)
        if (data === null)
            return null
        return JSON.parse(data)
    }

    override set(key: string, value: object): void {
        localStorage.setItem(key, JSON.stringify(value))
    }

    override remove(key: string): void {
        localStorage.removeItem(key)
    }

    protected override clear(): void {
        localStorage.clear()
    }
}

export default StorageLocalStorage;
