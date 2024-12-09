import { assert, assertFalse } from '@std/assert'
import { isKoishiPlugin } from './npm.ts'

Deno.test('test isKoishiPlugin', () => {
    assert(isKoishiPlugin("@koishijs/plugin-console"))
    assert(isKoishiPlugin("@koishijs/plugin-http"))
    assert(isKoishiPlugin("@koishijs/plugin-adapter-discord"))
    assert(isKoishiPlugin("@koishijs/plugin-adapter-satori"))
    assert(isKoishiPlugin("koishi-plugin-dataview"))
    assert(isKoishiPlugin("koishi-plugin-github"))
    assert(isKoishiPlugin("koishi-plugin-adapter-onebot"))
    assert(isKoishiPlugin("koishi-plugin-k2345-security"))
    assert(isKoishiPlugin("@cyancy/koishi-plugin-dispose-root"))
    assertFalse(isKoishiPlugin("@corkcah/core"))
    assertFalse(isKoishiPlugin("@corkcah/dom"))
    assertFalse(isKoishiPlugin("vue"))
    assertFalse(isKoishiPlugin("typescript"))
    assertFalse(isKoishiPlugin("koishi"))
    assertFalse(isKoishiPlugin("koishi-utils"))
    assertFalse(isKoishiPlugin("@satorijs/satori"))
    assertFalse(isKoishiPlugin("@koishijs/utils"))
})
