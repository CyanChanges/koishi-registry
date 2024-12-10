import * as cordis from "cordis";
import { Server } from "./server.ts";
import Schema from 'schemastery'

// export interface Context {
//     fetch(
//         request: Request,
//         // deno-lint-ignore ban-types
//         env?: {},
//         ctx?: ExecutionContext,
//     ): Awaitable<Response>;
// }

export class Context extends cordis.Context {
    constructor(config: Context.Config = {}) {
        super();
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

export abstract class Service<T = any, C extends Context = Context> extends cordis.Service<T, C> {
    override [cordis.Service.setup]() {
        this.ctx = new Context() as C
    }
}
