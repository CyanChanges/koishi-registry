import { Context } from "./context.ts";
import NpmWatcher from "./npm.ts";
import Logger from 'reggol'
import * as KoishiRegistry from './koishi_registry'
import * as API from './api.ts'
import "@std/dotenv/load";

// TODO: use cordis loader

Logger.levels.base = 5
const app = new Context({
    server: {
        port: Deno.env.get('PORT') ? parseInt(Deno.env.get('PORT')!) : 8080
    }
});
app.plugin(KoishiRegistry)
app.plugin(NpmWatcher, { block_size: 1000, concurrent: 50 })
app.plugin(API)

await app.start()
