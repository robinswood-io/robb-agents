import { describe, expect, it } from "bun:test";
import { buildObjectiveContractPrompt, transitionObjectiveContract } from "./objective-contract.ts";

describe('contextual Gmail execution guidance', () => {
  it('uses a signed preflight for an authorized thread reply without asking for an internal id', () => {
    const text = 'Réponds à Alice dans le fil Gmail existant.';
    const objective = transitionObjectiveContract({ messageId: 'gmail-root', text, nowMs: 1 });
    const prompt = buildObjectiveContractPrompt(objective, [
      { id: 'gmail-root', role: 'user', content: text, timestamp: 1 },
    ]);
    expect(prompt).toContain('signed Gmail preflight and bound reply');
    expect(prompt).toContain('do not ask the user to confirm an internal Gmail message ID');
    expect(prompt).toContain('without a separate user review');
    expect(prompt).toContain('If the objective is only to analyze or prepare a draft, do not transmit');
    expect(prompt).toContain('If the exact audience, required content or authority to transmit genuinely remains unresolved');
    expect(prompt).toContain('Never send incomplete content or change the authorized audience');
  });
});
