import { compare, format, parse, SemVer } from '@std/semver'
import * as cordis from "cordis";
import { Server } from "./server.ts";
import Storage from "./storage";
import Logger from 'reggol'
import Schema from 'schemastery'
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
        this.plugin(Storage)
        this.provide('info', new AppInfo(this), true)
    }
}

export enum Updated {
    None,
    Upgrade,
    Downgrade
}

export class AppInfo {
    isUpdated: Promise<boolean>
    isUpgrade: Promise<boolean>
    isDowngrade: Promise<boolean>
    checkTask: Promise<Updated>
    previous: SemVer | null = null
    version: SemVer = parse(meta.version)

    constructor(protected ctx: Context) {
        this.checkTask = this.check()
        this.isUpdated = new Promise(r => this.checkTask.then(x => x !== Updated.None).then(r))
        this.isUpgrade = new Promise(r => this.checkTask.then(x => x === Updated.Upgrade).then(r))
        this.isDowngrade = new Promise(r => this.checkTask.then(x => x === Updated.Downgrade).then(r))
        this.ctx.scope.ensure(() => this.checkTask.then())
    }

    async check(): Promise<Updated> {
        try {
            const current = this.version
            const original = await this.ctx.storage.getRaw("version")
            if (original === null) {
                this.ctx.logger.info("updated to %c", format(current))
                this.ctx.emit("core/updated", parse("0.0.1"), current)
                return Updated.Upgrade
            }
            const previous = this.previous = parse(original)
            const ordering = compare(previous, current)
            if (ordering !== 0) {
                this.ctx.logger.info("detected update %c -> %c", format(previous), format(current))
                this.ctx.emit("core/updated", previous, current)
                return ordering == 1 ? Updated.Downgrade : Updated.Upgrade
            } else return Updated.None
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

