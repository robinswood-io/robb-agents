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
  const internals = manager as unknown as {
    sessions: Map<string, Managed>;
    spawnDelegatedSession: (parent: Managed, input: unknown) => Promise<{ sessionId: string; status: string }>;
    createSession: (workspaceId: string, options: CreateOptions, internal: { delegation: SessionDelegation }) => Promise<unknown>;
    flushSession: (sessionId: string) => Promise<void>;
    persistSession: (session: Managed) => void;
    sendMessage: (sessionId: string, prompt: string, ...args: unknown[]) => Promise<void>;
    sendEvent: () => void;
    resolveObjectiveMutationAuthority: (managed: Managed, objective: Managed['activeObjective']) => {
      terminalReconciliationPolicy?: {
        invocationCapabilityKey?: string;
        waitReviewerSessionIds: string[];
      };
    };
    consumeTerminalInvocationCapability: (
      managed: Managed,
      toolName: string,
      input: Record<string, unknown>,
      presented?: string,
    ) => boolean;
  };
  sessionRuntimeStateForTest(manager).sessions.set(parent.id, parent);
  const creations: Array<{ options: CreateOptions; delegation: SessionDelegation }> = [];
  const sent: Array<{ sessionId: string; prompt: string; permissionMode?: PermissionMode }> = [];
  const persisted: Array<Pick<Managed, 'id' | 'permissionMode' | 'delegation'>> = [];
  internals.persistSession = session => { persisted.push(JSON.parse(JSON.stringify(pickSessionFields(session)))); };
  internals.flushSession = async () => {};
  internals.sendEvent = () => {};
  internals.sendMessage = async (sessionId, prompt, ...args) => {
    sent.push({ sessionId, prompt, permissionMode: sessionRuntimeStateForTest(manager).sessions.get(sessionId)?.permissionMode });
    const acknowledge = args[5] as ((messageId: string) => void) | undefined;
    acknowledge?.(`${sessionId}-durable-dispatch`);
  };
  // Only external boundaries are replaced: exercise the real host admission, budget,
  // request parsing, route inheritance, review binding, and dispatch method.
  internals.createSession = async (_workspaceId, options, internal) => {
    creations.push({ options, delegation: internal.delegation });
    const child = createManagedSession({ id: `child-${creations.length}`, ...options,
      delegation: internal.delegation } as never, workspace);
    sessionRuntimeStateForTest(manager).sessions.set(child.id, child);
    internals.persistSession(child);
    return child;
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
