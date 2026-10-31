import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { transitionObjectiveContract } from "../objective-contract.ts";
import { HOST_PARENT_REVIEW_INSTRUCTION, prependHostDelegatedReviewerScope } from "../delegated-review-outcome.ts";



export const hash = 'a'.repeat(64);

export const revision = '1234567' + 'a'.repeat(33);

export const drift = '9876543' + 'b'.repeat(33);

export const safeGit = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';

export const legacyGitWithoutSignatureGuards = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager';

export const reviewGit = `${safeGit} -C /srv/review`;

export const ids = ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'];

export const binding = { objectiveId: 'parent-objective', acceptanceSha256: hash };

export const template = JSON.stringify({ verdict: 'PASS|FAIL', criteria: ids.map(id => ({ id, passed: false })), findings: [], ...binding }).replaceAll('"passed":false', '"passed":true|false');

export const scope = `Agis comme contre-relecteur indépendant hostile en lecture seule. Audit exact du worktree /srv/review, commit ${revision}. Ne modifie et ne déploie rien. Retourne uniquement ce reçu JSON : ${template}. Binding obligatoire : ${JSON.stringify(binding)}.`;


export function fixture() {
  const objective = { ...transitionObjectiveContract({ messageId: 'review-objective', text: scope, nowMs: 1 }),
    // Persisted flags are retained, but must not force a reviewer to mutate or
    // obtain another reviewer for its own negative findings.
    requiresExecutionEvidence: true,
    completionCriteria: [...ids, 'independent-review-passed'] as ReturnType<typeof transitionObjectiveContract>['completionCriteria'],
    acceptanceRegisteredAt: 10,
    acceptanceCriteria: [{ id: 'audit-head', description: 'Check the requested version.', toolName: 'Bash', input: { command: `${reviewGit} rev-parse HEAD` }, checks: [{ path: '$text', equals: revision }] }],
  };
  const observation: Message = { id: 'observation', role: 'tool', content: '', timestamp: 20, toolName: 'Bash', toolUseId: 'actual-call', toolStatus: 'completed', toolExecuted: true, toolInput: { command: `${reviewGit} rev-parse HEAD` }, toolResult: `${revision}\n` };
  const receipt = { verdict: 'FAIL', criteria: ids.map(id => ({ id, passed: false })), findings: ['A material defect remains in the inspected code.'], ...binding };
  const finalMessage: Message = { id: 'final', role: 'assistant', content: JSON.stringify(receipt), timestamp: 30 };
  const messages: Message[] = [{ id: objective.userMessageId, role: 'user', content: scope, timestamp: 1 }, observation, finalMessage];
  return { parentSessionId: 'parent-session', objective, observation, receipt, finalMessage, messages };
}


export function remoteFixture() {
  const f = fixture();
  const originalText = `Réponds uniquement en JSON compact. Tu dois vérifier en lecture seule via la source rbw-servers le dépôt dev:/srv/review. HEAD=${revision}. Retourne ${template}`;
  f.objective.originalText = originalText;
  f.messages[0]!.content = originalText;
  const toolInput = { server: 'dev', cwd: '/srv/review', command: `${safeGit} rev-parse HEAD` };
  Object.assign(f.observation, { toolName: 'mcp__rbw-servers__ssh_execute', toolInput, toolResult: JSON.stringify({ stdout: `${revision}\n` }) });
  Object.assign(f.objective.acceptanceCriteria[0]!, { toolName: f.observation.toolName, input: structuredClone(toolInput), checks: [{ path: '$.stdout', equals: `${revision}\n` }] });
  return f;
}


export function multiTargetHostFixture(indexedBrowserCommand = false) {
  const revisionUrl = 'https://orion.example.test/healthz';
  const targetChecks: ObjectiveAcceptanceCriterion[] = [
    {
      id: 'orion-revision', description: 'The deployed revision endpoint responds.', requirementId: 'deployed-revision',
      toolName: 'mcp__session__browser_tool', input: indexedBrowserCommand
        ? { 'command.0': 'navigate', 'command.1': revisionUrl }
        : { command: `navigate ${revisionUrl}` },
      checks: [{ path: '$.success', equals: true }],
    },
    {
      id: 'orion-user-access', description: 'The user-facing service responds.', requirementId: 'user-access',
      toolName: 'mcp__session__browser_tool', input: { command: 'navigate https://orion.example.test' },
      checks: [{ path: '$.success', equals: true }],
    },
    {
      id: 'orion-operational-health', description: 'The deployment health check passes.', requirementId: 'operational-health',
      toolName: 'mcp__rbw-agents-oss__oss_healthcheck',
      input: { _displayName: 'Check Orion health', _intent: 'Observe the deployed Orion service health.' },
      checks: [{ path: '$.success', equals: true }],
    },
    {
      id: 'orion-requested-behavior', description: 'The remote Orion contract tests pass.', requirementId: 'requested-behavior',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'dev', cwd: '/srv/workspace/orion', command: 'bun run test:orion-contract' },
      checks: [{ path: '$.success', equals: true }, { path: '$.code', equals: 0 }],
    },
  ];
  const criteriaIds = [...ids, ...targetChecks.map(check => check.id)];
  const requestedTemplate = JSON.stringify({ verdict: 'PASS|FAIL', criteria: criteriaIds.map(id => ({ id, passed: false })), findings: [], ...binding })
    .replaceAll('"passed":false', '"passed":bool');
  const contractInstruction = HOST_PARENT_REVIEW_INSTRUCTION;
  const contract = {
    protocol: 'host-review-v2', ...binding, criteria: criteriaIds, targetChecks,
    instruction: contractInstruction,
  };
  const reviewBrief = `Agis comme contre-relecteur indépendant hostile en lecture seule. Inspecte /srv/workspace/orion, https://orion.example.test/healthz et https://orion.example.test. Ne modifie rien. Retourne uniquement ${requestedTemplate}`;
  const originalText = `${prependHostDelegatedReviewerScope(reviewBrief)}\n\n<host_parent_review_contract>${JSON.stringify(contract)}</host_parent_review_contract>`;
  const objective = {
    ...transitionObjectiveContract({ messageId: 'multi-review-objective', text: originalText, delegatedRole: 'reviewer', nowMs: 1 }),
    acceptanceRegisteredAt: 10,
    // Parent procedure IDs do not belong to this child objective; the exact
    // tool/input/result predicates remain unchanged.
    acceptanceCriteria: targetChecks.map(({ requirementId: _requirementId, ...check }) => structuredClone(check)),
  };
  const observations: Message[] = [
    { id: 'blocked-remote-test', role: 'tool', content: '', timestamp: 19, toolName: targetChecks[3]!.toolName,
      toolUseId: 'blocked-remote-call', toolStatus: 'error', toolExecuted: true, isError: true,
      toolInput: structuredClone(targetChecks[3]!.input), toolResult: 'MCP write operations are blocked in Explore mode.' },
    { id: 'revision-observation', role: 'tool', content: '', timestamp: 20, toolName: targetChecks[0]!.toolName,
      toolUseId: 'revision-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: indexedBrowserCommand ? { command: ['navigate', revisionUrl] } : structuredClone(targetChecks[0]!.input),
      toolResult: `Navigated to: ${revisionUrl}` },
    { id: 'access-observation', role: 'tool', content: '', timestamp: 21, toolName: targetChecks[1]!.toolName,
      toolUseId: 'access-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(targetChecks[1]!.input), toolResult: JSON.stringify({ success: true }) },
    { id: 'health-observation', role: 'tool', content: '', timestamp: 22, toolName: targetChecks[2]!.toolName,
      toolUseId: 'health-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(targetChecks[2]!.input), toolResult: JSON.stringify({ success: true }) },
  ];
  const passed = new Set(['requested-outcome-delivered', 'no-safe-work-remaining',
    'orion-revision', 'orion-user-access', 'orion-operational-health']);
  const receipt = { verdict: 'FAIL', criteria: criteriaIds.map(id => ({ id, passed: passed.has(id) })),
    findings: ['The exact remote contract test could not execute under the active read-only policy.'], ...binding };
  const finalMessage: Message = { id: 'multi-final', role: 'assistant', content: JSON.stringify(receipt), timestamp: 30 };
  const root: Message = { id: objective.userMessageId, role: 'user', content: originalText, timestamp: 1,
    internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent-session' } };
  return { parentSessionId: 'parent-session', objective, targetChecks, observations, receipt, finalMessage,
    reviewBrief, contractInstruction,
    messages: [root, ...observations, finalMessage] };
}


export function connectorHostFailFixture() {
  const targetChecks: ObjectiveAcceptanceCriterion[] = [
    {
      id: 'invoice-source', description: 'The source invoice has the requested identity.',
      toolName: 'mcp__comptabilite__sellsy_get_invoice', input: { id: 12345678 },
      checks: [{ path: '$.number', equals: 'INV-TEST-001' }],
    },
    {
      id: 'delivery-receipt', description: 'Exactly one matching sent message exists.',
      toolName: 'mcp__google-contacts__gmail_list_messages',
      input: { q: 'in:sent subject:"Re: facture INV-TEST-001"', maxResults: 5 },
      checks: [{ path: '$.resultCount', equals: 1 }],
    },
    {
      id: 'sharepoint-list', description: 'The requested SharePoint list exists.',
      toolName: 'mcp__plc-microsoft-365__graph_get',
      input: { endpoint: 'sites/site-id/lists?$filter=displayName%20eq%20\'Example%20HR\'' },
      checks: [{ path: '$.data.value.0.displayName', equals: 'Example HR' }],
    },
  ];
  const criteriaIds = [...ids, ...targetChecks.map(check => check.id)];
  const contract = {
    protocol: 'host-review-v2', ...binding, criteria: criteriaIds, targetChecks,
    instruction: HOST_PARENT_REVIEW_INSTRUCTION,
  };
  const originalText = `${prependHostDelegatedReviewerScope('Inspecte les trois sources exactes en lecture seule et rends un verdict factuel.')}

<host_parent_review_contract>${JSON.stringify(contract)}</host_parent_review_contract>`;
  const objective = transitionObjectiveContract({
    messageId: 'connector-review-objective', text: originalText,
    delegatedRole: 'reviewer', nowMs: 1,
  });
  const root: Message = {
    id: objective.userMessageId, role: 'user', content: originalText, timestamp: 1,
    internalOrigin: { kind: 'spawned-session', senderSessionId: 'parent-session' },
  };
  const observations: Message[] = [
    {
      id: 'invoice-observation', role: 'tool', content: '', timestamp: 10,
      toolName: targetChecks[0]!.toolName, toolUseId: 'invoice-call',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(targetChecks[0]!.input),
      toolResult: JSON.stringify({ number: 'INV-TEST-001' }),
    },
    {
      id: 'gmail-observation', role: 'tool', content: '', timestamp: 11,
      toolName: targetChecks[1]!.toolName, toolUseId: 'gmail-call',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(targetChecks[1]!.input),
      toolResult: JSON.stringify({ resultCount: 0, messages: [] }),
    },
    {
      id: 'graph-observation', role: 'tool', content: '', timestamp: 12,
      toolName: targetChecks[2]!.toolName, toolUseId: 'graph-call',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(targetChecks[2]!.input),
      toolResult: JSON.stringify({ data: { value: [] } }),
    },
  ];
  const passed = new Set(['no-safe-work-remaining', 'invoice-source']);
  const receipt = {
    verdict: 'FAIL', ...binding,
    criteria: criteriaIds.map(id => ({ id, passed: passed.has(id) })),
    findings: [
      'No matching Gmail SENT message exists.',
      'The requested SharePoint list is absent.',
    ],
  };
  const finalMessage: Message = {
    id: 'connector-review-final', role: 'assistant',
    content: JSON.stringify(receipt), timestamp: 20,
  };
  return {
    parentSessionId: 'parent-session', sessionId: 'connector-review-session',
    sourceSlugs: ['comptabilite', 'google-contacts', 'plc-microsoft-365'],
    objective, targetChecks, observations, receipt, finalMessage,
    messages: [root, ...observations, finalMessage],
  };
}


export function setMultiTargetHostBrief(f: ReturnType<typeof multiTargetHostFixture>, reviewBrief: string): void {
  const contract = {
    protocol: 'host-review-v2',
    ...binding,
    criteria: [...ids, ...f.targetChecks.map(check => check.id)],
    targetChecks: f.targetChecks,
    instruction: f.contractInstruction,
  };
  const originalText = `${prependHostDelegatedReviewerScope(reviewBrief)}\n\n<host_parent_review_contract>${JSON.stringify(contract)}</host_parent_review_contract>`;
  f.reviewBrief = reviewBrief;
  f.objective.originalText = originalText;
  f.messages[0]!.content = originalText;
}
