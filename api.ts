import { Context } from './context.ts'

export const inject = ['hono']

export function apply(ctx: Context) {
    let functionality = {
        registry: !!ctx.root.get('koishi'),
        analyzer: !!ctx.root.get('koishi.analyzer'),
        npm: !!ctx.root.get('npm')
    }
    const checkFunctionality = ctx.throttle(() => (functionality = {
        registry: !!ctx.root.get('koishi'),
        analyzer: !!ctx.root.get('koishi.analyzer'),
        npm: !!ctx.root.get('npm')
    }), 100)
    ctx.hono.get("/api/status", (c) => {
        checkFunctionality()
        return c.json({
            version: ctx.info.version,
            functionality: functionality,
        })
    })
    ctx.inject(['npm'], (ctx) => {
        ctx.hono.get("/api/plugins", (c) => {
            return c.json({
                synchronized: ctx.npm.synchronized,
                list: [...ctx.npm.plugins.keys()]
            });
        });
    })
    ctx.inject(['koishi', 'koishi.meta', 'koishi.analyzer'], (ctx) => {
        ctx.hono.get("/api/registry/status", (c) => {
            return c.json({
                version: ctx.info.version,
                updateAt: ctx.koishi.last_refresh.toUTCString(),
                synchronized: ctx.koishi.isSynchronized(),
                features: ctx.koishi.getFeatures(),
            })
        })
        ctx.hono.get("/api/registry/:name", async (c) => {
            const name = c.req.param('name')!
            const should_refresh = c.req.query("use_uncached")
            const result = await ctx.koishi.fetchObject(name, !!should_refresh, !!should_refresh)
            if (result === null)
                return c.json({
                    name: name,
                    status: 404,
                    message: "not found"
                }, 404)
            return c.json({
                name: name,
                status: 200,
                data: result,
                message: "fetched"
            })
        })
    })
}
