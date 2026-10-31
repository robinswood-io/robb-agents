import { describe, expect, it } from "bun:test";
import { consumeSourceActivationRestart } from "./SessionManager.ts";

describe('source activation stream boundary', () => {
  it('consumes only the matching generation marker', () => {
    const host = { sourceActivationRestartGeneration: 4 }

    expect(consumeSourceActivationRestart(host, 3)).toBe(false)
    expect(host.sourceActivationRestartGeneration).toBe(4)
    expect(consumeSourceActivationRestart(host, 4)).toBe(true)
    expect(host.sourceActivationRestartGeneration).toBeUndefined()
    expect(consumeSourceActivationRestart(host, 4)).toBe(false)
  })
});
