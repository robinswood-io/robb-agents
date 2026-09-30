import type { ThinkingLevel } from '@craft-agent/shared/agent';
import {
  AGENT_COST_CONTROL_DECISION_VERSION,
  getModelProvider,
  isModelAllowedForAuthProvider,
  type LlmConnection,
  type SelectionSnapshot,
  type SourceSensitivity,
} from '@craft-agent/shared/config';
import type { AgentProfile } from '@craft-agent/shared/missions';
import type { Session } from '@craft-agent/shared/protocol';
import { inheritMissionModelSettings } from './mission-model-settings.ts';

export type MissionRouteConnection = Pick<LlmConnection,
  'slug' | 'providerType' | 'models' | 'defaultModel' | 'piAuthProvider'>;

export interface MissionSelectionContext {
  sensitivity?: SourceSensitivity;
  sourceSlugs?: string[];
  difficulty?: 'simple' | 'standard' | 'complex';
  requiredCapabilities?: string[];
}

export interface EffectiveMissionRouteDecision extends SelectionSnapshot {
  origin: 'mission';
  profile: 'maximum-quality';
  version: typeof AGENT_COST_CONTROL_DECISION_VERSION;
}

export interface MissionRouteDecisionResult {
  policyAllowed: boolean;
  connectionSlug?: string;
  routingDecision?: EffectiveMissionRouteDecision;
  explanation: string;
}

/** Resolve and validate the host-owned selection without choosing a substitute. */
export function resolveExplicitMissionModel(input: {
  profile: AgentProfile;
  origin?: Pick<Session, 'llmConnection' | 'connectionRoutePinned' | 'model'
    | 'modelRoutePinned' | 'thinkingLevel' | 'thinkingLevelPinned'>;
  defaultConnectionSlug?: string;
  defaultThinkingLevel: ThinkingLevel;
  connections: readonly MissionRouteConnection[];
  routingContext?: MissionSelectionContext;
  missionObjective?: string;
  assignment?: string;
  reviewOnly?: boolean;
  measuredMissionUsd?: number;
  projectedMissionUsd?: number;
}): MissionRouteDecisionResult {
  const inherited = inheritMissionModelSettings(input.profile, input.origin, input.defaultConnectionSlug);
  const slug = inherited.llmConnection ?? input.defaultConnectionSlug;
  if (!slug) {
    return { policyAllowed: false, explanation: 'Mission has no non-empty explicit or default connection.' };
  }
  const connection = input.connections.find(candidate => candidate.slug === slug);
  if (!connection) {
    return { policyAllowed: false, explanation: 'The explicit or default Mission connection is unavailable.' };
  }
  const model = inherited.model?.trim() || connection.defaultModel?.trim();
  const expectedProvider = connection.providerType === 'anthropic' ? 'anthropic' : 'pi';
  const available = (connection.models ?? []).map(candidate => typeof candidate === 'string' ? candidate : candidate.id);
  if (!model || (getModelProvider(model) && getModelProvider(model) !== expectedProvider)
    || !isModelAllowedForAuthProvider(model, connection.piAuthProvider)
    || (available.length > 0 && !available.includes(model))) {
    return { policyAllowed: false, connectionSlug: slug, explanation: 'The selected Mission model is unavailable for this connection.' };
  }
  return {
    policyAllowed: true,
    connectionSlug: slug,
    routingDecision: {
      version: AGENT_COST_CONTROL_DECISION_VERSION,
      origin: 'mission',
      profile: 'maximum-quality',
      model,
      thinkingLevel: inherited.thinkingLevel ?? input.defaultThinkingLevel,
    },
    explanation: 'Explicit/default Mission provider, model and reasoning preserved.',
  };
}
