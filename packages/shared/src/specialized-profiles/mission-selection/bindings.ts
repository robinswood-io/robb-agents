import { createHash } from "node:crypto";
import { type SpecializedProfileCondition, type SpecializedProfileEvaluation, type SpecializedProfileRecord } from "../schema.ts";
import type { SpecializedMissionCapability, SpecializedMissionProfileReference, SpecializedMissionProfileState } from './contracts.ts';
import { ACTIVE_STATE_SET, BINDING_END, BINDING_START, SPECIALIZED_MISSION_PROFILE_BINDING_STATES, SpecializedMissionProfileReferenceSchema, SpecializedMissionProfileSelectionError } from './contracts.ts';

export function parseSpecializedMissionProfileReference(
  systemPrompt: string,
): SpecializedMissionProfileReference | null {
  if (!systemPrompt.startsWith(BINDING_START)) return null;
  const end = systemPrompt.indexOf(BINDING_END, BINDING_START.length);
  if (end < 0) {
    throw new SpecializedMissionProfileSelectionError('Specialized Mission profile binding is truncated');
  }
  const raw = systemPrompt.slice(BINDING_START.length, end);
  try {
    return SpecializedMissionProfileReferenceSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized Mission profile binding is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isSpecializedMissionProfileState(value: string): value is SpecializedMissionProfileState {
  return ACTIVE_STATE_SET.has(value);
}

export function isSpecializedMissionProfileBindingState(
  value: string,
): value is typeof SPECIALIZED_MISSION_PROFILE_BINDING_STATES[number] {
  return (SPECIALIZED_MISSION_PROFILE_BINDING_STATES as readonly string[]).includes(value);
}

export function latestPromotionTransitionForStage(
  profile: SpecializedProfileRecord,
  stage: SpecializedProfileEvaluation['stage'],
): SpecializedProfileRecord['transitions'][number] | undefined {
  const edge = stage === 'offline' ? { from: 'draft', to: 'shadow' }
    : stage === 'shadow' ? { from: 'shadow', to: 'opt-in' }
      : stage === 'opt-in' ? { from: 'opt-in', to: 'canary' }
        : stage === 'canary' ? { from: 'canary', to: 'default' }
          : undefined;
  if (!edge) return undefined;
  return profile.transitions
    .filter((transition) => transition.profileVersion === profile.currentVersion
      && transition.from === edge.from
      && transition.to === edge.to)
    .at(-1);
}

export function conditionMatches(
  condition: SpecializedProfileCondition,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const value = fields[condition.field];
  if (condition.operator === 'present') return value !== undefined && value !== null;
  if (value === undefined || value === null || condition.value === undefined) return false;
  if (condition.operator === 'equals') return String(value) === condition.value;
  if (condition.operator === 'includes') {
    return Array.isArray(value)
      ? value.some((entry) => String(entry) === condition.value)
      : String(value).includes(condition.value);
  }
  try {
    return new RegExp(condition.value, 'u').test(String(value));
  } catch {
    return false;
  }
}

export function qualifiedSystemPrompt(
  definition: SpecializedProfileRecord['versions'][number]['definition'],
): string {
  return [
    definition.systemPrompt,
    `Qualified objective: ${definition.objective}`,
    'Qualified success criteria:',
    ...definition.successCriteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`),
  ].join('\n');
}

export function serializeBinding(reference: SpecializedMissionProfileReference, prompt: string): string {
  return `${BINDING_START}${JSON.stringify(reference)}${BINDING_END}\n${prompt}`;
}

export function capabilityKey(kind: SpecializedMissionCapability['kind'], name: string): string {
  return `${kind}\u0000${name}`;
}

export function specializedProfileCapabilityEnvelopeIdentity(
  capabilities: readonly SpecializedMissionCapability[],
): string {
  return createHash('sha256').update(JSON.stringify(capabilities)).digest('hex');
}
