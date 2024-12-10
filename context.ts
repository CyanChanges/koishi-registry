import * as cordis from "cordis";
import { type ExecutionContext, Hono } from "hono";
import { Awaitable } from "cosmokit";
import { Router } from "./router.ts";

export interface Context {
    fetch(
        request: Request,
        // deno-lint-ignore ban-types
        env?: {},
        ctx?: ExecutionContext,
    ): Awaitable<Response>;

    [Context.events]: Events<this>;
}

export class Context extends cordis.Context {
    constructor() {
        super();
        this.plugin(Router);
        return Object.defineProperty(this, "fetch", {
            get() {
                return this.hono.fetch;
            },
        });
    }
}

export interface Events<C extends Context = Context> extends cordis.Events<C> {}

export { Service } from 'cordis'
