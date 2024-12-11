import { Context } from './context.ts'

export const inject = ['hono']

export function apply(ctx: Context) {
    ctx.inject(['npm'], (ctx) => {
        ctx.hono.get("/api/plugins", (c) => {
            return c.json([...ctx.npm.plugins.values()]);
        });
    })
    ctx.inject(['npm', 'koishi'], (ctx) => {
        ctx.hono.get("/api/status", (c) => {
            return c.json({
                updateAt: ctx.koishi.lastRefreshDate.toUTCString(),
                synchronized: ctx.npm.synchronized,
                features: ctx.koishi.getFeatures(),
            })
        })
    })
}
