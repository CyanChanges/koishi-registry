import { compare, parse, SemVer } from '@std/semver'
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

    constructor(protected ctx: Context) {
        this.isUpdated = this.check()
        this.ctx.scope.ensure(()=>this.isUpdated.then())
    }

    async check(): Promise<boolean> {
        try {
            const previous = await this.ctx.storage.getRaw("version")
            if (previous === null || compare(parse(previous), parse(meta.version)) !== 0) {
                this.ctx.logger.info("detected update %c -> %c", previous ?? '<unknown>', meta.version)
                this.ctx.emit("core/updated", previous ? parse(previous) : parse("0.0.1"), parse(meta.version))
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
    override [cordis.symbols.setup]() {
        this.ctx = new Context() as C
    }
}
// export { Service } from '@cordisjs/core'

