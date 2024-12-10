import { Context } from "./context.ts";
import { StorageLocalStorage } from "./storage/localstorage.ts";
import NpmWatcher from "./npm.ts";
import KoishiRegistry from './koishi_registry.ts'
import Logger from 'reggol'
import HttpService from '@cordisjs/plugin-http'
import * as LoggerService from "@cordisjs/plugin-logger";

Logger.levels.base = 5
const app = new Context();
app.plugin(LoggerService)
app.plugin(HttpService)
app.plugin(StorageLocalStorage)
app.plugin(NpmWatcher, { block_size: 1000, concurrent: 50 })
app.plugin(KoishiRegistry)

app.hono.get("/api/plugins", (c) => {
    return c.json([...app.npm.plugins.values()]);
});

await app.start()

Deno.serve(app.fetch);
