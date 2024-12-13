import { Context } from './context.ts'
import {} from './koishi_registry'

export const inject = ['hono']

export function apply(ctx: Context) {
    ctx.inject(['npm'], (ctx) => {
        ctx.hono.get("/api/plugins", (c) => {
            return c.json([...ctx.npm.plugins.values()]);
        });
    })
    ctx.inject(['koishi'], (ctx) => {
        ctx.hono.get("/api/status", (c) => {
            return c.json({
                version: ctx.info.version,
                updateAt: ctx.koishi.lastRefreshDate.toUTCString(),
                synchronized: ctx.koishi.isSynchronized(),
                features: ctx.koishi.getFeatures(),
            })
        })
        ctx.hono.get("/api/:name/", async (c) => {
            const { name } = c.req.param()
            const result = await ctx.koishi.fetch(name)
            if (result === null)
                return c.json({
                    name: name,
                    status: 404,
                    message: "not found"
                }, 404)
            else
                return c.json({
                    name: name,
                    status: 200,
                    data: result,
                    message: "fetched"
                })
        })
    })
}
