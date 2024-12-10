import { Context } from "./context.ts";
import { StorageLocalStorage } from "./storage/localstorage.ts";
import NpmWatcher from "./npm.ts";
import KoishiRegistry from './koishi_registry'
import Logger from 'reggol'
import HttpService from '@cordisjs/plugin-http'
import * as LoggerService from "@cordisjs/plugin-logger";
import * as API from './api.ts'
// import TimerService from '@cordisjs/timer'

// TODO: use cordis loader

Logger.levels.base = 5
const app = new Context({
    server: {
        port: 8080
    }
});
app.plugin(LoggerService)
app.plugin(HttpService)
app.plugin(StorageLocalStorage)
app.plugin(NpmWatcher, { block_size: 1000, concurrent: 50 })
app.plugin(KoishiRegistry)
app.plugin(API)


await app.start()
