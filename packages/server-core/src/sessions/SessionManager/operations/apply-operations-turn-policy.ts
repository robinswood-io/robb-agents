import { omitUndefined } from '@craft-agent/shared/utils/json';
import {
  getDefaultLlmConnection,
  getLlmConnections,
  getMiniModel,
  resolveAgentCostControlPolicy,
} from '@craft-agent/shared/config';
import { getRobbOperationsExtension } from '@craft-agent/shared/operations';
import { CodedError } from '@craft-agent/shared/protocol';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { ManagedSession } from '../managed-session.ts';

export interface OperationsTurnPolicyOwner {
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> | void;
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null): Promise<void> | void;
  setSessionThinkingLevel(sessionId: string, level: NonNullable<ManagedSession['thinkingLevel']>): void;
}

export type OperationsTurnPolicySession = Pick<
  ManagedSession,
  | 'id'
  | 'workspace'
  | 'llmConnection'
  | 'model'
  | 'thinkingLevel'
  | 'missionId'
  | 'missionWorkItemId'
  | 'missionRole'
  | 'messages'
  | 'tokenUsage'
  | 'enabledSourceSlugs'
  | 'missionRouteLockSha256'
  | 'isProcessing'
  | 'connectionRoutePinned'
  | 'modelRoutePinned'
  | 'thinkingLevelPinned'
>;

function modelCapabilityTierRank(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (/(?:opus|fable|pro-high|gpt-5\.4-pro)/u.test(lower)) return 0;
  if (/(?:sonnet|terra|medium|pro-low|gpt-5)/u.test(lower)) return 1;
  if (/(?:haiku|luna|mini|flash|spark|nano)/u.test(lower)) return 2;
  return 1;
}

function orderConnectionModelsByCapability(
  models: readonly string[] | undefined,
  defaultModel: string | undefined,
): string[] | undefined {
  if (!models || models.length <= 1) return models ? [...models] : undefined;
  return [...models].sort((left, right) => {
    const rankDiff = modelCapabilityTierRank(left) - modelCapabilityTierRank(right);
    if (rankDiff !== 0) return rankDiff;
    if (defaultModel) {
      if (left === defaultModel && right !== defaultModel) return -1;
      if (right === defaultModel && left !== defaultModel) return 1;
    }
    return 0;
  });
}

/** Run the optional commercial policy before a fresh user turn is persisted. */
export async function applyOperationsTurnPolicy(
  context: { readonly owner: OperationsTurnPolicyOwner },
  managed: OperationsTurnPolicySession,
  message: string,
): Promise<string> {
  const extension = getRobbOperationsExtension();
  if (!extension) return message;

  const connections = getLlmConnections();
  const accountSlug = managed.llmConnection ?? getDefaultLlmConnection() ?? undefined;
  if (extension.connectionPolicy === 'pinned-account' && !accountSlug) {
    throw new CodedError('OPERATIONS_POLICY_BLOCKED', 'Sélectionnez un compte IA avant de poursuivre.');
  }
  const candidates = extension.connectionPolicy === 'pinned-account'
    ? connections.filter(connection => connection.slug === accountSlug)
    : connections;
  if (candidates.length === 0) {
    throw new CodedError('OPERATIONS_POLICY_BLOCKED', 'Le compte IA sélectionné est indisponible.');
  }

  let decision: Awaited<ReturnType<typeof extension.beforeTurn>>;
  try {
    decision = await extension.beforeTurn({
      now: new Date().toISOString(),
      workspaceId: managed.workspace.id,
      workspaceRootPath: managed.workspace.rootPath,
      sessionId: managed.id,
      ...(managed.missionId !== undefined ? { missionId: managed.missionId } : {}),
      ...(managed.missionWorkItemId !== undefined ? { workItemId: managed.missionWorkItemId } : {}),
      ...(managed.missionRole !== undefined ? { missionRole: managed.missionRole } : {}),
      turnKind: 'new-request',
      message,
      hidden: false,
      messageCount: managed.messages.length,
      completedAssistantTurns: managed.messages.filter(candidate =>
        (candidate.role === 'assistant' || candidate.role === 'plan') && !candidate.isIntermediate
      ).length,
      recentUserMessages: managed.messages.filter(candidate => candidate.role === 'user' && !candidate.hidden)
        .slice(-3).map(candidate => candidate.content.slice(0, 2_000)),
      ...(managed.tokenUsage !== undefined ? { tokenUsage: managed.tokenUsage } : {}),
      ...(accountSlug !== undefined ? { currentConnectionSlug: accountSlug } : {}),
      ...(managed.model !== undefined ? { currentModel: managed.model } : {}),
      ...(managed.thinkingLevel !== undefined ? { currentThinkingLevel: managed.thinkingLevel } : {}),
      enabledSourceSlugs: managed.enabledSourceSlugs ?? [],
      connections: candidates.map(connection => {
        const rawModels = connection.models?.map(model => typeof model === 'string' ? model : model.id);
        return omitUndefined({
          slug: connection.slug,
          providerType: connection.providerType,
          defaultModel: connection.defaultModel,
          models: orderConnectionModelsByCapability(rawModels, connection.defaultModel),
          miniModel: getMiniModel(connection) ?? undefined,
          modelSelectionMode: connection.modelSelectionMode,
        });
      }),
    });
  } catch (error) {
    throw new CodedError('OPERATIONS_POLICY_BLOCKED',
      `Robb Operations: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (decision.decision !== 'allow') {
    throw new CodedError(
      decision.decision === 'require-approval' ? 'OPERATIONS_APPROVAL_REQUIRED' : 'OPERATIONS_POLICY_BLOCKED',
      decision.reason ?? 'Ce tour a été arrêté par Robb Operations.',
    );
  }
  const selected = candidates.find(connection => connection.slug === (decision.connectionSlug ?? accountSlug));
  if (!selected) {
    throw new CodedError('OPERATIONS_POLICY_BLOCKED', 'Robb Operations a choisi un compte IA non autorisé.');
  }
  if (decision.model) {
    const models = new Set([
      selected.defaultModel,
      getMiniModel(selected),
      ...(selected.models?.map(model => typeof model === 'string' ? model : model.id) ?? []),
    ]);
    if (!models.has(decision.model)) {
      throw new CodedError('OPERATIONS_POLICY_BLOCKED', 'Robb Operations a choisi un modèle indisponible.');
    }
  }

  // Mission routes are sealed by the host before dispatch. Commercial routing
  // may select a model only for ordinary, idle chats where automatic routing is active
  // and the user has not explicitly pinned the session route.
  const workspaceConfig = managed.workspace.rootPath
    ? loadWorkspaceConfig(managed.workspace.rootPath)
    : null;
  const legacyWorkspaceRoutingFlag: unknown = workspaceConfig
    ? Reflect.get(workspaceConfig, "automaticRoutingEnabled")
    : undefined;
  const automaticRoutingEnabled = legacyWorkspaceRoutingFlag !== false
    && resolveAgentCostControlPolicy(workspaceConfig?.costControl).automaticRoutingEnabled;
  if (!managed.missionRouteLockSha256 && !managed.isProcessing && automaticRoutingEnabled) {
    if (!managed.connectionRoutePinned && selected.slug !== managed.llmConnection) {
      await context.owner.setSessionConnection(managed.id, selected.slug);
    }
    if (!managed.modelRoutePinned && decision.model && decision.model !== managed.model) {
      await context.owner.updateSessionModel(managed.id, managed.workspace.id, decision.model);
    }
    if (!managed.thinkingLevelPinned && decision.thinkingLevel && decision.thinkingLevel !== managed.thinkingLevel) {
      context.owner.setSessionThinkingLevel(managed.id, decision.thinkingLevel);
    }
  }
  return decision.sanitizedMessage ?? message;
}
