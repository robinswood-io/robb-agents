import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE, buildObjectiveContractPrompt, hasObjectiveExecutionEvidence, hasObjectiveSubstantiveToolResult, transitionObjectiveContract, turnProgressFingerprint, turnProgressFingerprints } from "./objective-contract.ts";
import { extractObjectiveOutcome } from "./objective-outcome.ts";
import { FINAL_RESPONSE_GUIDANCE } from "@craft-agent/shared/prompts";

describe('durable objective contract', () => {
  it('advances evidence when the bounded result changes for the same normalized query', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Recherche', timestamp: 1 },
      {
        id: 'search-1', role: 'tool', content: 'first result', timestamp: 2,
        toolName: 'search', toolUseId: 's1', toolStatus: 'completed', toolInput: { query: '  VAT   receipt ' },
      },
    ];
    const first = turnProgressFingerprint(messages, 'u1');
    messages.push({
      id: 'search-2', role: 'tool', content: 'updated result', timestamp: 3,
      toolName: 'search', toolUseId: 's2', toolStatus: 'completed', toolInput: { query: 'VAT receipt' },
    });
    expect(turnProgressFingerprint(messages, 'u1')).not.toBe(first);
  });

  it('does not treat unchanged waits or reloads as progress', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Surveille', timestamp: 1 },
    ];
    const initial = turnProgressFingerprints(messages, 'u1');
    messages.push({
      id: 'wait', role: 'tool', content: 'still running', timestamp: 2,
      toolName: 'wait_threads', toolUseId: 'w1', toolStatus: 'completed', toolInput: { threadId: 't1' },
    }, {
      id: 'reload', role: 'tool', content: 'same page', timestamp: 3,
      toolName: 'browser', toolUseId: 'b1', toolStatus: 'completed', toolInput: { command: 'reload' },
    });
    expect(turnProgressFingerprints(messages, 'u1')).toEqual(initial);
  });

  it('separates executed mutation progress and excludes a non-executed checkpoint', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Corrige', timestamp: 1 },
      {
        id: 'blocked-edit', role: 'tool', content: 'Cost guard checkpoint: mutation Edit was not started.', timestamp: 2,
        toolName: 'Edit', toolUseId: 'e0', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.ts' },
        toolExecuted: false,
        toolCheckpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'structural checkpoint' },
      },
    ];
    const blocked = turnProgressFingerprints(messages, 'u1');
    expect(blocked.executionCount).toBe(0);
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(false);

    messages.push({
      id: 'executed-edit', role: 'tool', content: 'updated', timestamp: 3,
      toolName: 'Edit', toolUseId: 'e1', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.ts' },
      toolExecuted: true,
    });
    const executed = turnProgressFingerprints(messages, 'u1');
    expect(executed.executionCount).toBe(1);
    expect(executed.executionProgress).not.toBe(blocked.executionProgress);
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(true);
  });

  it('exposes only genuine substantive tool results for persisted evidence', () => {
    const base: Message = {
      id: 'read', role: 'tool', content: 'Read', timestamp: 1,
      toolName: 'Read', toolUseId: 'read-1', toolStatus: 'completed', toolExecuted: true,
      toolResult: 'verified contents',
    };
    expect(hasObjectiveSubstantiveToolResult(base)).toBe(true);
    expect(hasObjectiveSubstantiveToolResult({ ...base, toolResult: '' })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({ ...base, toolResult: 'auto-completed' })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({
      ...base,
      toolResult: 'Cost guard checkpoint: Read was not started.',
    })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({
      ...base,
      toolExecuted: false,
      toolResult: 'verified contents',
    })).toBe(false);
  });

  it('advances same-file Edit and Write mutations when transformer arguments differ', () => {
    for (const [toolName, transformKey] of [
      ['Edit', 'new_string'],
      ['Write', 'content'],
      ['Edit', 'patch'],
    ] as const) {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Modifie le fichier', timestamp: 1 },
        {
          id: `${toolName}-1`, role: 'tool', content: 'updated', timestamp: 2,
          toolName, toolUseId: `${toolName}-call-1`, toolStatus: 'completed', toolExecuted: true,
          toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'first transformation' },
        },
      ];
      const first = turnProgressFingerprints(messages, 'u1');
      messages.push({
        id: `${toolName}-2`, role: 'tool', content: 'updated', timestamp: 3,
        toolName, toolUseId: `${toolName}-call-2`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'second transformation' },
      });
      const second = turnProgressFingerprints(messages, 'u1');
      expect(second.executionCount).toBe(2);
      expect(second.executionProgress).not.toBe(first.executionProgress);
      expect(second.fingerprint).not.toBe(first.fingerprint);

      messages.push({
        id: `${toolName}-duplicate`, role: 'tool', content: 'updated', timestamp: 4,
        toolName, toolUseId: `${toolName}-call-duplicate`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'second transformation' },
      });
      expect(turnProgressFingerprints(messages, 'u1')).toEqual(second);
    }
  });

  it('requires concise host-verifiable outcome and independent-review receipts in the prompt', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u1',
      text: 'Corrige cette déclaration fiscale puis vérifie-la.',
    });
    const prompt = buildObjectiveContractPrompt(objective);
    expect(prompt.split(FINAL_RESPONSE_GUIDANCE)).toHaveLength(2);
    expect(prompt).toContain('Link any deliverable by its descriptive name to the actual available file or destination');
    expect(prompt).toContain('Do not label unchecked work "validated" or "ready"');
    expect(prompt).toContain('do not impose a fixed report template');
    expect(prompt).toContain('Valid state values are: complete_verified, blocked_human, blocked_policy, continue');
    expect(prompt).toContain('observable automated process is not a human blocker');
    expect(prompt).toContain('already proven to be pending from an identified third party is not a missing user choice');
    expect(prompt).toContain('do not call request_user_input merely to ask whether to wait');
    expect(prompt).toContain('Finish all independent safe work');
    expect(prompt).toContain(OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE);
    expect(extractObjectiveOutcome(OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE).declaration?.state).toBe('continue');
    expect(prompt).toContain('toolUseId values from successful tool results');
    expect(prompt).toContain('exactly one host-observed invocation qualifies');
    expect(prompt).toContain('Only the native Bash, bash and functions.bash spellings alias each other');
    expect(prompt).toContain('including MCP names, are exact and case-sensitive');
    expect(prompt).toContain('A blocker tool alias likewise requires exactly one host-observed failure');
    expect(prompt).toContain('one exact host-resolved tool alias');
    expect(prompt).not.toContain('never tool-name aliases');
    expect(prompt).toContain('blocker must be an object with kind, description, and evidence');
    expect(prompt).toContain('{"verdict":"PASS"');
    expect(prompt).toContain('A structured FAIL is successful review delivery and concrete corrective work');
    expect(prompt).toContain('invoking a reviewer alone is not evidence');
    expect(prompt).toContain('when a checklist materially helps track the remaining work');
    expect(prompt).toContain('it does not prove the final outcome or grant approval');
    expect(prompt).toContain('every 30–60 seconds');
    expect(prompt).not.toContain('progress updates rare');
    expect(prompt).toContain('in the user\'s language');
    expect(prompt).toContain('tied to the original request');
    expect(prompt).toContain('what was actually accomplished and verified, what failed or remains unaccomplished');
    expect(prompt).toContain('any concrete next action or input needed');
    expect(prompt).toContain('Keep the machine-readable receipt separate');
    const reviewLine = prompt.split('\n').find(line => line.startsWith('When asking an independent reviewer'))!;
    const review = JSON.parse(reviewLine.slice(reviewLine.indexOf('{')));
    expect(review.criteria).toEqual(objective.completionCriteria
      .filter(id => id !== 'independent-review-passed').map(id => ({ id, passed: true })));
    expect(prompt).not.toContain('a substantive content review may certify relevant-checks-passed alone');
    const reviewerPrompt = buildObjectiveContractPrompt({ ...objective, delegatedRole: 'reviewer' });
    expect(reviewerPrompt).toContain('Do not call update_plan or SubmitPlan for this bounded review');
  });

  it('requires the structured receipt only for missions or execution objectives', () => {
    const direct = transitionObjectiveContract({
      messageId: 'u-direct',
      text: 'Explique simplement ce terme.',
    });
    expect(direct.orchestrationMode).toBe('direct');
    expect(direct.requiresExecutionEvidence).toBeUndefined();
    expect(buildObjectiveContractPrompt(direct)).not.toContain('robb_objective_outcome');
    expect(buildObjectiveContractPrompt(direct)).toContain('a substantive content review may certify relevant-checks-passed alone');

    const execution = transitionObjectiveContract({
      messageId: 'u-execution',
      text: 'Corrige ce titre.',
    });
    expect(execution.requiresExecutionEvidence).toBe(true);
    expect(buildObjectiveContractPrompt(execution)).toContain('robb_objective_outcome');

    const mission = transitionObjectiveContract({
      messageId: 'u-mission',
      text: 'Analyse le NDA et le droit applicable de bout en bout.',
    });
    expect(mission.orchestrationMode).toBe('mission');
    expect(buildObjectiveContractPrompt(mission)).toContain('robb_objective_outcome');
  });
});
