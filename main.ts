import { Context } from "./context.ts";
import NpmWatcher from "./npm.ts";
import Logger from 'reggol'
import * as KoishiRegistry from './koishi_registry'
import * as API from './api.ts'
import * as MarketEndpoints from './market.ts'
import { SimpleAnalyzer } from "./analyzer";
import "@std/dotenv/load";

// TODO: use cordis loader

const host = Deno.env.get("HOST") ?? '127.0.0.1'
const port = parseInt(Deno.env.get("PORT") ?? '8080')

Logger.levels.base = 5
const app = new Context({
    server: {
        host, port
    }
});
app.plugin(SimpleAnalyzer) // analyzer is required for KoishiRegistry
app.plugin(KoishiRegistry)
app.plugin(NpmWatcher, { block_size: 1000, concurrent: 50 })
app.plugin(API)
app.plugin(MarketEndpoints)

await app.start()
