import { managedToSession } from '../SessionManager/session-presentation.ts';
import { sessionManagerForTest } from "./private-runtime-access.ts";
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { withSessionOperationsForTest } from "./session-operation-access.ts";
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupModeState, deriveTerminalReconciliationInvocationCapability, TERMINAL_RECONCILIATION_CAPABILITY_FIELD, type PermissionMode } from "@craft-agent/shared/agent";
import { pickSessionFields, type SessionDelegation } from "@craft-agent/shared/sessions";
import { createManagedSession, SessionManager } from "../SessionManager.ts";
import { transitionObjectiveContract } from "../objective-contract.ts";



export type Managed = ReturnType<typeof createManagedSession>;

export type CreateOptions = NonNullable<Parameters<SessionManager['createSession']>[1]>;

export const cleanup: Array<() => void> = [];


export function harness(permissionMode: PermissionMode = 'allow-all') {
  const rootPath = mkdtempSync(join(tmpdir(), 'robb-delegation-host-'));
  const workspace = { id: 'workspace', name: 'Test', slug: 'test', rootPath, createdAt: 1 };
  const parent = createManagedSession({ id: 'root', permissionMode, projectId: 'project-1',
    llmConnection: 'test-connection', model: 'test-model', enabledSourceSlugs: ['documents'] }, workspace);
  parent.isProcessing = true;
  parent.activeObjective = transitionObjectiveContract({ messageId: 'root-request', text: 'Vérifie les documents fournis.', nowMs: 1 });
  const manager = withSessionOperationsForTest(new SessionManager());
  const internals = sessionManagerForTest(manager);
  sessionRuntimeStateForTest(manager).sessions.set(parent.id, parent);
  const creations: Array<{ options: CreateOptions; delegation: SessionDelegation }> = [];
  const sent: Array<{ sessionId: string; prompt: string; permissionMode?: PermissionMode }> = [];
  const persisted: Array<ReturnType<typeof pickSessionFields>> = [];
  internals.persistSession = session => {
    const snapshot = pickSessionFields(session);
    persisted.push(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot);
    return true;
  };
  internals.flushSession = async () => {};
  internals.sendEvent = () => {};
  internals.sendMessage = async (sessionId, prompt, ...args) => {
    sent.push(omitUndefined<{ sessionId: string; prompt: string; permissionMode?: PermissionMode }>({ sessionId, prompt, permissionMode: sessionRuntimeStateForTest(manager).sessions.get(sessionId)?.permissionMode }));
    const acknowledge = args[5] as ((messageId: string) => void) | undefined;
    acknowledge?.(`${sessionId}-durable-dispatch`);
  };
  // Only external boundaries are replaced: exercise the real host admission, budget,
  // request parsing, route inheritance, review binding, and dispatch method.
  internals.createSession = async (_workspaceId, options, internal) => {
    if (!options || !internal?.delegation) throw new Error('Delegation fixture requires the host lineage');
    creations.push({ options, delegation: internal.delegation });
    const child = createManagedSession({ ...omitUndefined<Partial<Managed>>({ ...options,
      delegation: internal.delegation }), id: `child-${creations.length}` }, workspace, { messagesLoaded: true });
    sessionRuntimeStateForTest(manager).sessions.set(child.id, child);
    internals.persistSession(child);
    return managedToSession(child);
  };
  cleanup.push(() => {
    for (const id of sessionRuntimeStateForTest(manager).sessions.keys()) cleanupModeState(id);
    rmSync(rootPath, { recursive: true, force: true });
  });
  const spawn = (input: Record<string, unknown> = { prompt: 'Inspecte la cible précise.' }) => {
    const policy = parent.activeObjective
      ? internals.resolveObjectiveMutationAuthority(parent, parent.activeObjective)
        .terminalReconciliationPolicy
      : undefined;
    const capability = deriveTerminalReconciliationInvocationCapability(
      policy?.invocationCapabilityKey,
      'mcp__session__spawn_session',
      input,
    );
    return internals.spawnDelegatedSession(parent, capability ? {
      ...input,
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: capability,
    } : input);
  };
  return { parent, manager, internals, creations, sent, persisted, spawn };
}


export function makeInitialTerminalReviewReady(parent: Managed): void {
  const objective = parent.activeObjective!;
  parent.activeObjective = {
    ...objective,
    risk: 'high-stakes',
    requiresAcceptanceCriteria: true,
    completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    acceptanceCriteria: [{
      id: 'target-observed',
      description: 'The exact target state is observed.',
      toolName: 'mcp__documents__inspect',
      input: { target: 'document-1' },
      checks: [{ path: '$.ok', equals: true }],
    }],
    acceptanceRegisteredRevision: objective.acceptanceRevision ?? objective.userMessageId,
    acceptanceRegisteredAt: 3,
    terminalReconciliation: {
      messageId: 'terminal-close',
      timestamp: 2,
      initialAcceptanceRegistrationRequired: true,
    },
  };
}
