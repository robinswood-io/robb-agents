import { describe, it, expect } from "bun:test";
import { buildGeneratorPrompt, buildRepairPrompt } from "./generator-prompt.ts";

describe('generator-prompt', () => {
  it('instructs the model that every reference must resolve to a declared node', () => {
    const prompt = buildGeneratorPrompt('Decompose the goal', 'My task');
    expect(prompt).toContain('${nodes.<id>.output} reference MUST point to an `id` that you actually declare');
    expect(prompt).toContain('one clear specialist responsibility');
    expect(prompt).toContain('work autonomously through completion');
    expect(prompt).toContain('Goal: Decompose the goal');
    expect(prompt).toContain('Working title: My task');
  });

  it('repair prompt lists each validation error and re-asserts the YAML-only contract', () => {
    const prompt = buildRepairPrompt([
      { path: 'nodes.design.inputs', message: 'Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"' },
      { path: 'root', message: 'second problem' },
    ]);
    expect(prompt).toContain('- nodes.design.inputs: Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"');
    expect(prompt).toContain('- root: second problem');
    expect(prompt).toContain('Output ONLY the YAML');
  });
});
