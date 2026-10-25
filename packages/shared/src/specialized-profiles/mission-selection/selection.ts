import type { AgentProfile } from "../../missions/index.ts";
import { SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE, canonicalSpecializedProfileVersionHash, specializedProfileEvaluationPassesPromotionGate, specializedProfileTransitionIsPromotion, type SpecializedProfileEvaluation, type SpecializedProfileRecord, type SpecializedProfileRegistryDocument } from "../schema.ts";
import { capabilityKey, conditionMatches, isSpecializedMissionProfileBindingState, isSpecializedMissionProfileState, latestPromotionTransitionForStage, qualifiedSystemPrompt, serializeBinding, specializedProfileCapabilityEnvelopeIdentity } from './bindings.ts';
import type { SpecializedMissionCapability, SpecializedMissionProfileReference, SpecializedMissionProfileSelection, SpecializedMissionProfileState, SpecializedMissionSelectionContext } from './contracts.ts';
import { ACTIVE_STATE_RANK, SPECIALIZED_MISSION_PROFILE_ID_PREFIX, selectionError } from './contracts.ts';

const REQUIRED_QUALIFICATION_STAGES: Readonly<
  Record<SpecializedMissionProfileState, readonly SpecializedProfileEvaluation['stage'][]>
> = Object.freeze({
  'opt-in': ['offline', 'shadow'],
  canary: ['offline', 'shadow', 'opt-in'],
  default: ['offline', 'shadow', 'opt-in', 'canary'],
});

/**
 * Re-evaluate the complete qualification chain at selection time. A lifecycle
 * transition is historical evidence; it does not make expired evaluations
 * current forever.
 */
export function specializedProfileHasCurrentMissionQualification(
  profile: SpecializedProfileRecord,
  at: string | Date,
  expected?: {
    executionRouteSha256: string;
    capabilityEnvelopeSha256: string;
  },
): boolean {
  if (!isSpecializedMissionProfileState(profile.currentState)) return false;
  const definition = profile.versions[profile.currentVersion - 1]?.definition;
  if (!definition) return false;
  const currentEntry = profile.transitions.at(-1);
  const monitoringStage: SpecializedProfileEvaluation['stage'] = profile.currentState === 'default'
    ? 'regression'
    : profile.currentState;
  const currentMonitoring = profile.evaluations
    .filter((evaluation) => evaluation.profileVersion === profile.currentVersion
      && evaluation.stage === monitoringStage
      && evaluation.stageEntryTransitionSequence === currentEntry?.sequence)
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
    .at(-1);
  const latestEvaluation = profile.evaluations
    .filter((evaluation) => evaluation.profileVersion === profile.currentVersion)
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
    .at(-1);
  const matchesEffectiveExecution = (evaluation: SpecializedProfileEvaluation) => !expected
    || (evaluation.executionRouteSha256 === expected.executionRouteSha256
      && evaluation.capabilityEnvelopeSha256 === expected.capabilityEnvelopeSha256);
  const baseEvaluations = REQUIRED_QUALIFICATION_STAGES[profile.currentState].map((stage) => {
    const transition = latestPromotionTransitionForStage(profile, stage);
    if (!transition) return undefined;
    return profile.evaluations.find((candidate) =>
      transition.evaluationIds.includes(candidate.id)
      && candidate.profileVersion === profile.currentVersion
      && candidate.stage === stage);
  });
  const baseChainCertified = baseEvaluations.every((evaluation) => evaluation !== undefined
    && matchesEffectiveExecution(evaluation)
    // A fresh monitoring campaign may renew time validity, but never replace
    // the quality/integrity proof of the promotion chain.
    && specializedProfileEvaluationPassesPromotionGate(evaluation, definition, evaluation.completedAt));
  if (currentMonitoring) {
    if (latestEvaluation
      && Date.parse(latestEvaluation.completedAt) > Date.parse(currentMonitoring.completedAt)
      && latestEvaluation.outcome !== 'pass') return false;
    // A current monitoring pass renews the active-state qualification. A
    // negative or inconclusive result suspends selection immediately.
    return baseChainCertified
      && matchesEffectiveExecution(currentMonitoring)
      && specializedProfileEvaluationPassesPromotionGate(currentMonitoring, definition, at);
  }
  // A downgrade after a negative outcome cannot reactivate stale historical
  // promotion evidence. The new lifecycle entry needs a fresh monitoring pass.
  if (latestEvaluation?.outcome !== 'pass') return false;
  return baseEvaluations.every((evaluation) => evaluation !== undefined
    && matchesEffectiveExecution(evaluation)
    && specializedProfileEvaluationPassesPromotionGate(evaluation, definition, at));
}

/**
 * Resolve one explicitly requested Mission profile against the governed
 * registry. The qualified definition supplies role instructions only: model,
 * connection, permissions, skills, tools, and sources remain the exact Mission
 * capability ceiling and are never copied from the registry.
 */
export function selectSpecializedMissionProfile(input: {
  requestedProfile: AgentProfile;
  registry: SpecializedProfileRegistryDocument | null;
  context: SpecializedMissionSelectionContext;
  at: string | Date;
  expected?: SpecializedMissionProfileReference;
  /** Host-internal only. Renderer/user Mission admission never sets this. */
  evaluationStage?: SpecializedProfileEvaluation['stage'];
  evaluationCohortId?: string;
}): SpecializedMissionProfileSelection | null {
  const { requestedProfile, registry, context, at, expected } = input;
  const evaluationStage = input.evaluationStage ?? expected?.evaluationStage;
  if (input.evaluationStage && expected?.evaluationStage
    && input.evaluationStage !== expected.evaluationStage) {
    throw selectionError(requestedProfile.id, 'changed its host evaluation stage binding');
  }
  if (input.evaluationCohortId && expected?.evaluationCohortId
    && input.evaluationCohortId !== expected.evaluationCohortId) {
    throw selectionError(requestedProfile.id, 'changed its host evaluation cohort binding');
  }
  const reservedId = requestedProfile.id.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX);
  if (!reservedId && !expected) return null;
  const record = registry?.profiles.find((candidate) => candidate.id === requestedProfile.id);
  if (!record) {
    throw selectionError(requestedProfile.id, 'is not present in the verified workspace registry');
  }
  const version = record.versions[record.currentVersion - 1];
  if (!version) throw selectionError(record.id, `has no version ${record.currentVersion}`);
  const versionSha256 = canonicalSpecializedProfileVersionHash(version);
  const capabilityEnvelope = [...context.capabilities].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  const capabilityEnvelopeSha256 = specializedProfileCapabilityEnvelopeIdentity(capabilityEnvelope);
  const executionRouteSha256 = context.executionRouteSha256;
  const evaluationCohortId = input.evaluationCohortId
    ?? expected?.evaluationCohortId;
  if (Boolean(evaluationStage) !== Boolean(evaluationCohortId)) {
    throw selectionError(requestedProfile.id, 'has an incomplete host evaluation cohort binding');
  }
  if (evaluationStage) {
    const campaign = record.evaluationCampaigns?.find(({ id }) => id === evaluationCohortId);
    const missionId = context.fields['mission.id'];
    if (!campaign
      || campaign.profileVersion !== record.currentVersion
      || campaign.stage !== evaluationStage
      || campaign.stageEntryTransitionSequence !== record.transitions.at(-1)?.sequence
      || typeof missionId !== 'string'
      || !campaign.missionIds.includes(missionId)
      || (input.evaluationStage !== undefined && campaign.state !== 'open')) {
      throw selectionError(requestedProfile.id, 'has no matching open host campaign reservation');
    }
  }
  if (evaluationStage) {
    const evaluationState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[evaluationStage];
    if (record.currentState !== evaluationState) {
      throw selectionError(
        record.id,
        `cannot run ${evaluationStage} evaluation in state ${record.currentState}; expected ${evaluationState}`,
      );
    }
    // Host-internal evaluation remains available to recover a suspended
    // active state. Ordinary Missions below still fail closed.
  } else {
    if (!isSpecializedMissionProfileState(record.currentState)) {
      throw selectionError(record.id, `is inactive in state ${record.currentState}`);
    }
    if (!specializedProfileHasCurrentMissionQualification(record, at, {
      executionRouteSha256,
      capabilityEnvelopeSha256,
    })) {
      throw selectionError(record.id, 'does not have a current complete qualification chain');
    }
  }
  if (!isSpecializedMissionProfileBindingState(record.currentState)) {
    throw selectionError(record.id, `cannot bind lifecycle state ${record.currentState}`);
  }
  const selectedState = record.currentState;
  if (expected) {
    const evaluationBinding = expected.evaluationStage !== undefined;
    const selectedEntry = record.transitions[expected.lifecycleEntryTransitionSequence - 1];
    const subsequentTransitions = record.transitions.slice(expected.lifecycleEntryTransitionSequence);
    const monotonePromotionChain = selectedEntry?.sequence === expected.lifecycleEntryTransitionSequence
      && selectedEntry.profileVersion === expected.profileVersion
      && selectedEntry.to === expected.selectedState
      && subsequentTransitions.every((transition) =>
        transition.profileVersion === expected.profileVersion
        && transition.from !== null
        && specializedProfileTransitionIsPromotion(transition.from, transition.to));
    const selectedStateCompatible = evaluationBinding
      ? expected.selectedState === record.currentState
      : isSpecializedMissionProfileState(expected.selectedState)
        && isSpecializedMissionProfileState(record.currentState)
        && ACTIVE_STATE_RANK[record.currentState] >= ACTIVE_STATE_RANK[expected.selectedState]
        && monotonePromotionChain;
    const lifecycleEntryCompatible = evaluationBinding
      ? expected.lifecycleEntryTransitionSequence === record.transitions.at(-1)?.sequence
      : selectedStateCompatible;
    if (expected.profileId !== record.id
      || expected.profileVersion !== record.currentVersion
      || !selectedStateCompatible
      || !lifecycleEntryCompatible
      || expected.versionSha256 !== versionSha256
      || expected.capabilityEnvelopeSha256 !== capabilityEnvelopeSha256
      || expected.executionRouteSha256 !== executionRouteSha256) {
      throw selectionError(
        record.id,
        `drifted from selected version ${expected.profileVersion} or its host capability envelope`,
      );
    }
    if (registry!.revision < expected.registryRevisionAtSelection) {
      throw selectionError(record.id, 'registry revision moved backwards after selection');
    }
  }
  if (version.definition.role !== requestedProfile.role) {
    throw selectionError(
      record.id,
      `qualified role ${version.definition.role} does not match Mission role ${requestedProfile.role}`,
    );
  }

  const available = new Set(context.capabilities.map(({ kind, name }) => capabilityKey(kind, name)));
  const requested = new Set(version.definition.requestedCapabilities.map(({ kind, name }) =>
    capabilityKey(kind, name)));
  const missing = version.definition.requestedCapabilities
    .filter((capability) => capability.required && !available.has(capabilityKey(capability.kind, capability.name)))
    .map((capability) => `${capability.kind}:${capability.name}`)
    .sort();
  if (missing.length > 0) {
    throw selectionError(record.id, `is missing required Mission capabilities: ${missing.join(', ')}`);
  }
  const surplus = context.capabilities
    .filter(({ kind, name }) => !requested.has(capabilityKey(kind, name)))
    .map(({ kind, name }) => `${kind}:${name}`)
    .sort();
  if (surplus.length > 0) {
    throw selectionError(record.id, `would exceed its evaluated capability envelope: ${surplus.join(', ')}`);
  }

  for (const condition of version.definition.eligibilityCriteria) {
    if (!conditionMatches(condition, context.fields)) {
      throw selectionError(record.id, `failed eligibility criterion ${condition.id}`);
    }
  }
  for (const condition of version.definition.abstentionCriteria) {
    if (conditionMatches(condition, context.fields)) {
      throw selectionError(record.id, `matched abstention criterion ${condition.id}`);
    }
  }

  const reference: SpecializedMissionProfileReference = expected ?? {
    schemaVersion: 1,
    profileId: record.id,
    profileVersion: record.currentVersion,
    selectedState,
    lifecycleEntryTransitionSequence: record.transitions.at(-1)!.sequence,
    registryRevisionAtSelection: registry!.revision,
    registryHeadSha256AtSelection: registry!.head.documentSha256,
    versionSha256,
    capabilityEnvelopeSha256,
    executionRouteSha256,
    ...(evaluationStage ? { evaluationStage } : {}),
    ...(evaluationCohortId ? { evaluationCohortId } : {}),
  };
  const capabilityNames = (kind: SpecializedMissionCapability['kind']) => new Set(
    capabilityEnvelope.filter((capability) => capability.kind === kind).map((capability) => capability.name),
  );
  const workspaceWriteAllowed = capabilityNames('workspace-write').size > 0;
  const externalMutationAllowed = capabilityNames('external-mutation').size > 0;
  const profile = {
    ...requestedProfile,
    specialty: version.definition.specialty,
    systemPrompt: serializeBinding(reference, qualifiedSystemPrompt(version.definition)),
    skills: requestedProfile.skills.filter((name) => capabilityNames('skill').has(name)),
    tools: requestedProfile.tools.filter((name) => capabilityNames('tool').has(name)),
    sources: requestedProfile.sources.filter((name) => capabilityNames('source').has(name)),
    permissionMode: workspaceWriteAllowed || externalMutationAllowed
      ? requestedProfile.permissionMode
      : 'safe' as const,
  };
  return {
    profile,
    binding: {
      ...reference,
      currentState: selectedState,
      currentRegistryRevision: registry!.revision,
      currentRegistryHeadSha256: registry!.head.documentSha256,
      provenance: structuredClone(version.provenance),
      capabilityEnvelope,
    },
  };
}
