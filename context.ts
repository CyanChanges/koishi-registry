import * as cordis from "cordis";
import { Server } from "./server.ts";
import Logger from 'reggol'
import Schema from 'schemastery'
import HttpService from '@cordisjs/plugin-http'
import * as LoggerService from "@cordisjs/plugin-logger";
import TimerService from '@cordisjs/timer'
import SchemaService from "@cordisjs/schema";
import meta from './deno.json' with { type: 'json' }

export interface Events<C extends Context = Context> extends cordis.Events<C> {
}

export interface Context {
    [Context.events]: Events<this>
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
        this.plugin(Server, config.server);
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

// export { Service } from '@cordisjs/core'

export abstract class Service<C extends Context = Context> extends cordis.Service<C> {
    override [cordis.symbols.setup]() {
        this.ctx = new Context() as C
    }
}
