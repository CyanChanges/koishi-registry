import { Context } from "./context.ts";
import Schema from 'schemastery'
import { Service } from 'cordis'
import { Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router"
import type { BlankInput, H, Handler, RouterRoute } from "hono/types";

declare module 'cordis' {
    export interface Context {
        hono: Server;
        server: Server;
        router: Server;
    }
}

export class Server extends Hono {
    // deno-lint-ignore no-explicit-any
    override router: TrieRouter<[Handler<any, any, BlankInput, any>, RouterRoute]>;
    [Service.tracker] = {
        associate: 'hono',
        property: 'ctx',
    }
    _server?: Deno.HttpServer<Deno.NetAddr>;

    constructor(protected ctx: Context, protected config: Server.Config) {
        // deno-lint-ignore no-explicit-any
        const router: TrieRouter<[Handler<any, any, BlankInput, any>, RouterRoute]> = new TrieRouter();

        ctx.provide('hono', undefined, true)
        ctx.alias('hono', ['server', 'router'])

        super({router})
        this.router = router

        this.ctx.on('ready', ()=>{
            this.notFound((c) => {
                // this.ctx.logger.debug("page not found\t\t", c.req.path)
                return c.text("Not Found", 404)
            })

            if (!this._server)
                this._server = Deno.serve(
                    {
                        hostname: config.host,
                        port: config.port,
                        reusePort: true
                    },
                    this.fetch
                )

            this.ctx.on('dispose', ()=>this._server?.shutdown())
        })

        ctx.set('hono', this)
    }

    protected override _addRoute(method: string, path: string, handler: H): void {
        super._addRoute(method, path, handler)
        this.ctx.scope.disposables.push(() => {
           this.router.remove(method, path)
        })
    }
}

export namespace Server {
    export interface Config {
        host?: string
        port?: number
    }
    export const Config = Schema.object({
        host: Schema.string().default('0.0.0.0'),
        port: Schema.number().min(0).max(65535).default(8000)
    })
}
