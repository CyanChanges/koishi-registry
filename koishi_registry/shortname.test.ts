import { shortnameOf } from "./mod.ts";
import { assertEquals } from '@std/assert'

Deno.test('shortnameOf', () => {
    assertEquals(shortnameOf("@koishijs/plugin-echo"), "echo")
    assertEquals(shortnameOf("koishi-plugin-dataview"), "dataview")
    assertEquals(shortnameOf("@cyancy/koishi-plugin-reg"), "@cyancy/reg")
    assertEquals(shortnameOf("@miemiemie/koishi-plugin-screeps-tool"), "@miemiemie/screeps-tool")
})
