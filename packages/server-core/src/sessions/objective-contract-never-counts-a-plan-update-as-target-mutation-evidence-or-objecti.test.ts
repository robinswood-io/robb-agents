import { expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { hasObjectiveSubstantiveToolResult, isObjectiveMutationTool, turnProgressFingerprints } from "./objective-contract.ts";

it('never counts a plan update as target mutation, evidence or objective progress', () => {
  const user: Message = { id: 'u-plan', role: 'user', content: 'Créer un rapport', timestamp: 1 };
  for (const toolName of ['update_plan', 'mcp__session__update_plan', 'session__update_plan', 'functions.update_plan', 'TodoWrite']) {
    const update: Message = { id: 't-plan', role: 'tool', content: '', timestamp: 2, toolName,
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"plan":[{"step":"Rapport livré","status":"completed"}]}' };
    expect(isObjectiveMutationTool(update)).toBe(false);
    expect(hasObjectiveSubstantiveToolResult(update)).toBe(false);
    expect(turnProgressFingerprints([user, update], user.id)).toEqual(turnProgressFingerprints([user], user.id));
  }
});
