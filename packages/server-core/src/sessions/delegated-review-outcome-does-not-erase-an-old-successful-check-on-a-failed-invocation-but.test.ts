import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { objectiveReviewBinding, transitionObjectiveContract } from "./objective-contract.ts";
import { HOST_PARENT_REVIEW_INSTRUCTION, prependHostDelegatedReviewerScope, validateDelegatedReviewCompletion } from "./delegated-review-outcome.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { binding, drift, fixture, ids, legacyGitWithoutSignatureGuards, reviewGit, revision, safeGit, template } from "./testing/delegated-review-outcome-fixture.ts";

describe('completion of a delegated read-only review', () => {
  it('does not erase an old successful check on a failed invocation, but uses a newer observed result', () => {
    for (const changes of [{ toolStatus: 'error' as const, isError: true }, { toolExecuted: false },
      { toolCheckpoint: { schemaVersion: 1 as const, kind: 'tool-call-budget' as const, reason: 'budget' } }]) {
      const f = fixture();
      f.finalMessage.content = JSON.stringify({ ...f.receipt, verdict: 'PASS', findings: [], criteria: ids.map(id => ({ id, passed: true })) });
      f.messages.splice(2, 0, { ...f.observation, ...changes, id: 'latest-check', timestamp: 25 });
      expect(validateDelegatedReviewCompletion(f)?.valid).toBe(true);
    }
    const changed = fixture();
    changed.finalMessage.content = JSON.stringify({ ...changed.receipt, verdict: 'PASS', findings: [], criteria: ids.map(id => ({ id, passed: true })) });
    changed.messages.splice(2, 0, { ...changed.observation, id: 'latest-check', timestamp: 25, toolResult: `${drift}\n` });
    expect(validateDelegatedReviewCompletion(changed)?.valid).toBe(false);
    const empty = fixture();
    empty.finalMessage.content = JSON.stringify({ ...empty.receipt, verdict: 'PASS', findings: [], criteria: ids.map(id => ({ id, passed: true })) });
    empty.messages.splice(2, 0, { ...empty.observation, id: 'empty-check', timestamp: 25, toolResult: '' });
    expect(validateDelegatedReviewCompletion(empty)?.valid).toBe(false);
  });

  it('rejects fabricated stdout, comment-only targets, opaque execution and git -C mutations', () => {
    for (const command of [
      `test -n /srv/review && printf '${revision}'`,
      'git -C /srv/elsewhere rev-parse HEAD # /srv/review',
      'git -C /srv/review/../elsewhere rev-parse HEAD',
      `printf 'git -C /srv/review rev-parse HEAD: ${revision}'`,
      `${reviewGit} reset --hard`,
      `${reviewGit} branch new-branch`,
      `${reviewGit} diff --output=/tmp/report`,
      `${reviewGit} log --format=${revision}`,
      `${reviewGit} rev-parse --sq-quote ${revision}`,
      `${reviewGit} diff --no-index /srv/elsewhere/a /srv/elsewhere/b`,
      `${reviewGit} rev-parse HEAD | cat`,
      `${safeGit} -C /srv/review grep --open-files-in-page=/usr/bin/true x`,
      `${safeGit} -C /srv/review grep --ext-gr x`,
      `${safeGit} -C /srv/review log --pretty=format:%G? -1`,
      `${safeGit} -C /srv/review log --show-signature --no-patch -n 1`,
      `${safeGit} -c log.showSignature=true -C /srv/review log --no-patch -n 1`,
      `${safeGit} -c format.pretty=%G? -C /srv/review log --no-patch -n 1`,
      `${legacyGitWithoutSignatureGuards} -C /srv/review log --no-patch -n 1`,
      'git --no-optional-loc -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C /srv/review rev-parse HEAD',
      'git --no-optional-locks -c core.fsmon=false -c core.hooksPath=/dev/null --no-pager -C /srv/review rev-parse HEAD',
      'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --paginate -C /srv/review rev-parse HEAD',
      'python -c "print(123)" # /srv/review',
    ]) {
      const f = fixture(); f.objective.acceptanceCriteria[0]!.input.command = command; f.observation.toolInput = { command };
      expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
    }
    const f = fixture(); f.messages.splice(2, 0, { ...f.observation, id: 'reset', toolInput: { command: 'git -C /srv/review reset --hard' } });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
  });

  it('binds every review read and Git command to the exact local target and transport', () => {
    for (const command of [
      'cat /srv/review/app.ts /srv/other/secret',
      'head /srv/review/app.ts /srv/other/secret',
      'tail /srv/review/app.ts /srv/other/secret',
      'diff /srv/review/app.ts /srv/other/secret',
      `${reviewGit} rev-parse HEAD && ${safeGit} -C /srv/other rev-parse HEAD`,
      `${safeGit} -C /srv/review grep -f /srv/other/secret x`,
      `${safeGit} -C /srv/review grep --file=/srv/other/secret x`,
      `${safeGit} -C /srv/review ls-files --exclude-from=/srv/other/secret`,
      'diff --from-file=/etc/passwd /srv/review/app.ts',
      'diff --from-file /etc/passwd /srv/review/app.ts',
      'diff --to-file=/etc/passwd /srv/review/app.ts',
      'diff --exclude-from=/etc/passwd /srv/review/app.ts',
      'wc --files0-from=/etc/passwd /srv/review/app.ts',
      'wc --files0-from /etc/passwd /srv/review/app.ts',
      'tail -F /srv/review/app.ts',
      'tail --follow /srv/review/app.ts',
    ]) {
      const f = fixture();
      f.objective.acceptanceCriteria[0]!.input.command = command;
      f.observation.toolInput = { cwd: '/srv/review', command };
      expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
    }

    const remoteOnLocalReview = fixture();
    const command = `${safeGit} rev-parse HEAD`;
    const toolInput = { server: 'prod', cwd: '/srv/review', command };
    Object.assign(remoteOnLocalReview.observation, {
      toolName: 'mcp__rbw-servers__ssh_execute',
      toolInput,
      toolResult: JSON.stringify({ stdout: `${revision}\n` }),
    });
    Object.assign(remoteOnLocalReview.objective.acceptanceCriteria[0]!, {
      toolName: remoteOnLocalReview.observation.toolName,
      input: structuredClone(toolInput),
      checks: [{ path: '$.stdout', equals: `${revision}\n` }],
    });
    expect(validateDelegatedReviewCompletion(remoteOnLocalReview)?.valid).toBe(false);

    for (const toolName of [
      'mcp__evil__bash', 'mcp__evil__shell', 'mcp__evil__exec_command',
    ]) {
      const untrustedShell = fixture();
      Object.assign(untrustedShell.observation, { toolName });
      Object.assign(untrustedShell.objective.acceptanceCriteria[0]!, { toolName });
      expect(validateDelegatedReviewCompletion(untrustedShell)?.valid).toBe(false);
    }

    for (const toolName of [
      'mcp__evil__read', 'mcp__evil__fetch', 'mcp__evil__get',
    ]) {
      const untrustedRead = fixture();
      const toolInput = { file_path: '/srv/review/app.ts' };
      Object.assign(untrustedRead.observation, {
        toolName, toolInput, toolResult: revision,
      });
      Object.assign(untrustedRead.objective.acceptanceCriteria[0]!, {
        toolName, input: structuredClone(toolInput), checks: [{ path: '$text', equals: revision }],
      });
      expect(validateDelegatedReviewCompletion(untrustedRead)?.valid).toBe(false);
    }
  });

  it('binds a real HEAD observation through explicit cwd and ignores echoed metadata or ambiguous revisions', () => {
    const f = fixture(); const command = `${safeGit} rev-parse --abbrev-ref HEAD && ${safeGit} rev-parse HEAD`;
    Object.assign(f.objective.acceptanceCriteria[0]!, { input: { cwd: '/srv/review', command }, checks: [{ path: '$.stdout', equals: `main\n${revision}\n` }] });
    f.observation.toolInput = { cwd: '/srv/review', command };
    f.observation.toolResult = JSON.stringify({ stdout: `main\n${revision}\n` });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(true);
    f.observation.toolResult = JSON.stringify({ stdout: `${drift}\n`, command: revision });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
    f.observation.toolResult = JSON.stringify({ stdout: `${drift}\n${revision}\n` });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
  });

  it('accepts the real read-only branch --show-current followed by HEAD, without allowing branch creation', () => {
    const f = fixture(); const command = `${safeGit} branch --show-current && ${safeGit} rev-parse HEAD`;
    Object.assign(f.objective.acceptanceCriteria[0]!, { input: { cwd: '/srv/review', command }, checks: [{ path: '$.stdout', equals: `main\n${revision}\n` }] });
    f.observation.toolInput = { cwd: '/srv/review', command };
    f.observation.toolResult = JSON.stringify({ stdout: `main\n${revision}\n` });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(true);
  });

  it('refuses inconsistent, duplicate, mismatched, malformed and multiple receipts', () => {
    for (const receipt of [
      { verdict: 'PASS' }, { findings: [] }, { objectiveId: 'other' }, { acceptanceSha256: 'b'.repeat(64) },
      { criteria: [{ id: ids[0], passed: false }] }, { criteria: ids.map(() => ({ id: ids[0], passed: false })) },
      { criteria: ids.map(id => ({ id, passed: 'true' })) }, { findings: [{}] },
    ]) {
      const f = fixture(); f.finalMessage.content = JSON.stringify({ ...f.receipt, ...receipt });
      expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
    }
    for (const content of ['FAIL', '{}', 'null', '[]', `${template}\n${template}`, `Example: ${template}`]) {
      const f = fixture(); f.finalMessage.content = content; expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
    }
  });

  it('rejects a target mutation, while coordination and quoted code in a Read result are not mutations', () => {
    const f = fixture();
    f.messages.splice(1, 0, { ...f.observation, id: 'spawn', toolName: 'mcp__session__spawn_session', toolInput: { task: 'Read the existing correction.' }, toolResult: '{"sessionId":"child"}' });
    f.messages.splice(2, 0, { ...f.observation, id: 'read', toolName: 'Read', toolInput: { file_path: '/srv/review/app.ts' }, toolResult: 'Example source: git push; rm -rf directory; no real command was executed.' });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(true);
    f.messages.splice(3, 0, { ...f.observation, id: 'mutation', toolName: 'Edit', toolInput: { file_path: '/srv/review/app.ts', new_string: 'updated' }, toolResult: 'File updated' });
    expect(validateDelegatedReviewCompletion(f)?.valid).toBe(false);
  });

  it('does not promote the delivered FAIL into an independent PASS for the parent', () => {
    const f = fixture(); expect(validateDelegatedReviewCompletion(f)?.valid).toBe(true);
    const objective = { ...transitionObjectiveContract({ messageId: 'parent-objective', text: 'Fix security and verify the result.', nowMs: 1 }), requiresAcceptanceCriteria: false };
    const review = { ...f.receipt, ...objectiveReviewBinding(objective) };
    const wait: Message = { ...f.observation, id: 'wait', toolUseId: 'wait-call', toolName: 'mcp__session__wait_sessions', toolInput: { sessionIds: ['child'] }, toolResult: JSON.stringify({ outcome: 'completed', sessions: [{ sessionId: 'child', state: 'idle', reason: 'complete', finalText: JSON.stringify(review) }] }) };
    const result = validateObjectiveOutcome({ state: 'complete_verified', criteria: objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: ['wait-call', 'assistant-final'] })), remainingWork: [], blocker: null }, { objective, messages: [{ id: objective.userMessageId, role: 'user', content: objective.originalText!, timestamp: 1 }, wait] });
    expect(result.valid).toBe(false);
    expect(result.gaps).toContain('criterion lacks observed evidence: independent-review-passed');
  });

  it('accepts local Bash targetChecks without cwd when paths are explicit and ignores blocked Explore interpreter attempts', () => {
    const targetChecks: ObjectiveAcceptanceCriterion[] = [
      {
        id: 'csv-sha',
        description: 'Verify CSV SHA-256.',
        toolName: 'Bash',
        input: { command: 'shasum -a 256 /private/tmp/robb-yolo-live-artifacts/mesures.csv' },
        checks: [{ path: '$text', equals: '82a3dda6562f10eeffead00c415c386d18d969e8ebb9bcc3128d3f0ae029c6d7  /private/tmp/robb-yolo-live-artifacts/mesures.csv' }],
      },
      {
        id: 'report-head',
        description: 'Verify report lines.',
        toolName: 'Bash',
        input: { command: 'sed -n 1,5p /private/tmp/robb-yolo-live-artifacts/rapport.md' },
        checks: [{ path: '$text', equals: '# Rapport\nlignes=12\ntotal=650' }],
      },
    ];
    const criteriaIds = [...ids, ...targetChecks.map(check => check.id)];
    const contract = {
      protocol: 'host-review-v2',
      ...binding,
      criteria: criteriaIds,
      targetChecks,
      instruction: HOST_PARENT_REVIEW_INSTRUCTION,
    };
    const originalText = `${prependHostDelegatedReviewerScope('Vérifie en lecture seule les artefacts générés.')}\n\n<host_parent_review_contract>${JSON.stringify(contract)}</host_parent_review_contract>`;
    const objective = transitionObjectiveContract({
      messageId: 'local-bash-review',
      text: originalText,
      delegatedRole: 'reviewer',
      nowMs: 1,
    });
    const root: Message = {
      id: objective.userMessageId,
      role: 'user',
      content: originalText,
      timestamp: 1,
      internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent-session' },
    };
    const blockedInlineInterpreter: Message = {
      id: 'blocked-python',
      role: 'tool',
      content: '',
      timestamp: 10,
      toolName: 'Bash',
      toolUseId: 'blocked-python-call',
      toolStatus: 'error',
      isError: true,
      toolExecuted: true,
      toolInput: { command: 'python3 -c "import csv; print(12)"' },
      toolResult: 'Bash command blocked: compound command contains unsafe operations.\nEffective mode: Explore',
    };
    const csvObs: Message = {
      id: 'csv-obs',
      role: 'tool',
      content: '',
      timestamp: 11,
      toolName: 'Bash',
      toolUseId: 'csv-call',
      toolStatus: 'completed',
      toolExecuted: true,
      toolInput: { command: 'shasum -a 256 /private/tmp/robb-yolo-live-artifacts/mesures.csv' },
      toolResult: '82a3dda6562f10eeffead00c415c386d18d969e8ebb9bcc3128d3f0ae029c6d7  /private/tmp/robb-yolo-live-artifacts/mesures.csv\n',
    };
    const reportObs: Message = {
      id: 'report-obs',
      role: 'tool',
      content: '',
      timestamp: 12,
      toolName: 'Bash',
      toolUseId: 'report-call',
      toolStatus: 'completed',
      toolExecuted: true,
      toolInput: { command: 'sed -n 1,5p /private/tmp/robb-yolo-live-artifacts/rapport.md' },
      toolResult: '# Rapport\nlignes=12\ntotal=650\n',
    };
    const extraWcObs: Message = {
      id: 'extra-wc',
      role: 'tool',
      content: '',
      timestamp: 13,
      toolName: 'Bash',
      toolUseId: 'extra-wc-call',
      toolStatus: 'completed',
      toolExecuted: true,
      toolInput: { command: 'wc -l /private/tmp/robb-yolo-live-artifacts/mesures.csv' },
      toolResult: '      13 /private/tmp/robb-yolo-live-artifacts/mesures.csv\n',
    };
    const finalMessage: Message = {
      id: 'local-bash-final',
      role: 'assistant',
      timestamp: 20,
      content: JSON.stringify({
        verdict: 'PASS',
        ...binding,
        criteria: criteriaIds.map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    const validation = validateDelegatedReviewCompletion({
      parentSessionId: 'parent-session',
      objective,
      messages: [root, blockedInlineInterpreter, csvObs, reportObs, extraWcObs, finalMessage],
      finalMessage,
    });
    expect(validation).toMatchObject({
      valid: true,
      state: 'complete_verified',
      declaration: { criteria: [{ id: 'delegated-review-delivered', satisfied: true }] },
    });
  });
});
