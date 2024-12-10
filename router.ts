import { Context, Service } from "./context.ts";
import { Hono, type ExecutionContext } from "hono";
import { TrieRouter } from "hono/router/trie-router"
import type { BlankInput, H, Handler, RouterRoute } from "hono/types";

declare module 'cordis' {
    export interface Context {
        hono: Router;
        server: Router;
        router: Router;
    }
}

export class Router extends Hono {
    // deno-lint-ignore no-explicit-any
    override router: TrieRouter<[Handler<any, any, BlankInput, any>, RouterRoute]>;
    [Service.tracker] = {
        associate: 'hono',
        property: 'ctx',
    }

    constructor(protected ctx: Context) {
        // deno-lint-ignore no-explicit-any
        const router: TrieRouter<[Handler<any, any, BlankInput, any>, RouterRoute]> = new TrieRouter();

        ctx.provide('hono', undefined, true)
        ctx.alias('hono', ['server', 'router'])

        super({router})
        this.router = router

        const self = Context.associate(this, 'server')
        ctx.set('hono', self)

        return self
    }

    protected override _addRoute(method: string, path: string, handler: H): void {
        super._addRoute(method, path, handler)
        this.ctx.scope.disposables.push(() => {
           this.router.remove(method, path)
        })
    }
}
