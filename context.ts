import { compare, parse, SemVer, format } from '@std/semver'
import * as cordis from "cordis";
import { Server } from "./server.ts";
import { StorageLocalStorage } from "./storage/localstorage.ts";
import Logger from 'reggol'
import Schema from 'schemastery'
import TimerService from '@cordisjs/timer'
import SchemaService from "@cordisjs/schema";
import HttpService from '@cordisjs/plugin-http'
import * as LoggerService from "@cordisjs/plugin-logger";
import meta from './deno.json' with { type: 'json' }

export interface Events<in C extends Context = Context> extends cordis.Events<C> {
    'core/updated'(previous: SemVer, current: SemVer): void
}

export interface Context {
    [Context.events]: Events<this>
    info: AppInfo
}

export class Context extends cordis.Context {
    constructor(config: Context.Config = {}) {
        super();
        const logger = new Logger("app")
        logger.info("Fetcher/%C Deno/%C", meta.version, Deno.version.deno)
        this.plugin(SchemaService)
        this.plugin(LoggerService)
        // this.plugin(TimerService)
        this.plugin(HttpService)
        this.plugin(Server, config.server)
        this.plugin(StorageLocalStorage)
        this.provide('info', new AppInfo(this), true)
    }
}

export class AppInfo {
    isUpdated: Promise<boolean>
    previous: SemVer | null
    version: SemVer = parse(meta.version)

    constructor(protected ctx: Context) {
        this.isUpdated = this.check()
        this.previous = null
        this.ctx.scope.ensure(()=>this.isUpdated.then())
    }

    async check(): Promise<boolean> {
        try {
            const current = this.version
            const original = await this.ctx.storage.getRaw("version")
            if (original === null) {
                this.ctx.logger.info("updated to %c", format(current))
                this.ctx.emit("core/updated", parse("0.0.1"), current)
                return true
            }
            const previous = this.previous = parse(original)
            if (compare(previous, current) !== 0) {
                this.ctx.logger.info("detected update %c -> %c", format(previous), format(current))
                this.ctx.emit("core/updated", previous, current)
                return true
            } else return false
        } finally {
            await this.ctx.storage.setRaw("version", meta.version)
        }
    }
}

export namespace Context {
    export interface Config {
        server?: Server.Config
    }

    export const Config: Schema = Schema.object({
        server: Server.Config
    })

}

export abstract class Service<C extends Context = Context> extends cordis.Service<C> {
    protected declare ctx: C
}
// export { Service } from '@cordisjs/core'

