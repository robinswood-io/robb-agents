import { createHash } from "node:crypto";
import type { Message } from "@craft-agent/core/types";
import { classifyToolNameMutationSemantics, isProvablyReadOnlyShellCommand } from "@craft-agent/shared/agent";
import { GENERIC_EXECUTE_TOOL_PATTERN, MUTATION_HTTP_METHOD_PATTERN } from './intent-vocabulary.ts';
import { isObjectiveCoordinationTool, isObjectiveMutationTool, isObjectiveToolExecutedSuccessfully, isPassiveNoProgressTool, mutationTransformDigest, normalizedToolTarget, resultDigest } from './tool-evidence.ts';

/** Internal delivery and current-chat status do not change the verified target. */
export function isObjectiveEvidenceInvalidatingMutation(message: Message): boolean {
  const input = message.toolInput;
  // Limit this to the existing current-session handler shape. Other targets,
  // connector namespaces, permissions and future added operations stay guarded.
  const currentSessionStatus = /^(?:mcp__session__|session__)?set_session_status$/.test(message.toolName ?? '')
    && typeof input?.["status"] === 'string' && input["status"].trim().length > 0
    && Object.keys(input).every(key => key === 'status' || key === '_displayName' || key === '_intent');
  if (currentSessionStatus || isObjectiveCoordinationTool(message)) return false;
  if (isObjectiveMutationTool(message)) return true;

  // POST is also used by searches, validations and GraphQL queries. Method
  // alone therefore remains a conservative chronology boundary without
  // becoming positive proof that the requested mutation occurred.
  const method = input?.["method"];
  if (typeof method === 'string' && MUTATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;

  const toolName = message.toolName ?? '';
  const usesInputSemantics = GENERIC_EXECUTE_TOOL_PATTERN.test(toolName)
    || /^(?:functions\.)?(?:Bash|Shell)$/i.test(toolName);
  if (!usesInputSemantics) {
    // Mixed compound names such as `get_and_process` are deliberately not
    // accepted as observations. They must nevertheless invalidate an older
    // observation because their side effects are unknown.
    return classifyToolNameMutationSemantics(toolName) === 'ambiguous-compound';
  }

  const semanticInput = message.toolInput ?? {};
  const command = [semanticInput["command"], semanticInput["cmd"], semanticInput["script"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (command) {
    // Fail closed for completed shell execution unless the same AST-backed
    // policy used by Safe mode proves that every command is read-only.
    return !isProvablyReadOnlyShellCommand(command);
  }
  const query = [semanticInput["query"], semanticInput["sql"], semanticInput["statement"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  // A generic SQL executor does not expose enough database semantics to prove
  // that SELECT/functions/CTEs are side-effect free. It may still count as
  // positive execution only when the mutation grammar above recognizes it,
  // but every non-empty statement invalidates older target observations.
  if (query) return true;
  const action = [semanticInput["action"], semanticInput["operation"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return action ? classifyToolNameMutationSemantics(action) !== 'neutral' : false;
}

export interface TurnProgressFingerprints {
  /** Combined backwards-compatible fingerprint consumed by turn recovery. */
  fingerprint: string;
  /** Semantic observations: tool + normalized target/query + bounded result digest. */
  evidenceProgress: string;
  /** Confirmed mutations, kept separate from observational evidence. */
  executionProgress: string;
  evidenceCount: number;
  executionCount: number;
}

/** Stable semantic progress signals. Repeated reads, waits and unexecuted checkpoints do not advance them. */
export function turnProgressFingerprints(messages: Message[], userMessageId: string): TurnProgressFingerprints {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) {
    return {
      fingerprint: 'missing-objective',
      evidenceProgress: 'missing-objective',
      executionProgress: 'missing-objective',
      evidenceCount: 0,
      executionCount: 0,
    };
  }
  const evidence = new Set<string>();
  const execution = new Set<string>();
  for (const message of messages.slice(userIndex + 1)) {
    if (!isObjectiveToolExecutedSuccessfully(message) || isPassiveNoProgressTool(message)
      || isObjectiveCoordinationTool(message)) continue;
    const mutation = isObjectiveMutationTool(message);
    const transformDigest = mutation ? mutationTransformDigest(message.toolInput) : undefined;
    const signal = [
      (message.toolName ?? 'tool').toLowerCase(),
      normalizedToolTarget(message.toolInput),
      ...(transformDigest ? [`transform:${transformDigest}`] : []),
      resultDigest(message),
    ].join(':');
    (mutation ? execution : evidence).add(signal);
  }
  const evidenceSignals = [...evidence].sort().join('|');
  const executionSignals = [...execution].sort().join('|');
  const evidenceProgress = createHash('sha256').update(evidenceSignals).digest('hex').slice(0, 16);
  const executionProgress = createHash('sha256').update(executionSignals).digest('hex').slice(0, 16);
  return {
    fingerprint: createHash('sha256')
      .update(`e:${evidenceProgress}:${evidence.size}|x:${executionProgress}:${execution.size}`)
      .digest('hex')
      .slice(0, 16),
    evidenceProgress,
    executionProgress,
    evidenceCount: evidence.size,
    executionCount: execution.size,
  };
}

/** Backwards-compatible combined progress fingerprint. */
export function turnProgressFingerprint(messages: Message[], userMessageId: string): string {
  return turnProgressFingerprints(messages, userMessageId).fingerprint;
}

export function hasObjectiveExecutionEvidence(messages: Message[], userMessageId: string): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;
  const scoped = messages.slice(userIndex + 1);
  const nonReviewerSpawnedIds = new Set<string>();
  for (const message of scoped) {
    if (message.role === 'tool' && isObjectiveToolExecutedSuccessfully(message)
      && (message.toolName === 'mcp__session__spawn_session' || message.toolName === 'spawn_session')) {
      const role = typeof message.toolInput?.["role"] === 'string' ? message.toolInput["role"].trim().toLowerCase() : 'worker';
      if (role !== 'reviewer' && typeof message.toolResult === 'string') {
        try {
          const parsed = JSON.parse(message.toolResult) as { sessionId?: unknown };
          if (typeof parsed?.sessionId === 'string' && parsed.sessionId) {
            nonReviewerSpawnedIds.add(parsed.sessionId);
          }
        } catch {}
      }
    }
  }
  return scoped.some(message => {
    if (message.role === 'user' && message.internalOrigin?.kind === 'agent-message'
      && typeof message.content === 'string' && message.content.startsWith('[host-delegated-terminal-result-v1]\n')) {
      const headerLine = message.content.split('\n', 2)[1];
      if (headerLine) {
        try {
          const envelope = JSON.parse(headerLine) as { role?: unknown; state?: unknown; parentObjectiveId?: unknown };
          if (envelope?.state === 'complete_verified' && envelope?.role !== 'reviewer'
            && (!envelope.parentObjectiveId || envelope.parentObjectiveId === userMessageId)) {
            return true;
          }
        } catch {}
      }
    }
    if (message.role === 'tool' && isObjectiveToolExecutedSuccessfully(message)
      && (message.toolName === 'mcp__session__wait_sessions' || message.toolName === 'wait_sessions')
      && typeof message.toolResult === 'string' && nonReviewerSpawnedIds.size > 0) {
      try {
        const parsed = JSON.parse(message.toolResult) as { sessions?: Array<{ sessionId?: unknown; objectiveState?: unknown }> };
        if (Array.isArray(parsed?.sessions) && parsed.sessions.some(item => (
          typeof item?.sessionId === 'string' && nonReviewerSpawnedIds.has(item.sessionId)
          && item.objectiveState === 'complete_verified'
        ))) {
          return true;
        }
      } catch {}
    }
    // Potential/unknown mutations invalidate stale observations, but they do
    // not positively prove that the requested action occurred.
    return isObjectiveToolExecutedSuccessfully(message)
      && isObjectiveMutationTool(message)
      && isObjectiveEvidenceInvalidatingMutation(message);
  });
}
