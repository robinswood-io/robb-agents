import { z } from "zod";
import type { AgentProfile } from "../../missions/index.ts";
import { SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE, type SpecializedProfileProvenance } from "../schema.ts";

export const SPECIALIZED_MISSION_PROFILE_ID_PREFIX = 'specialist-' as const;

export const SPECIALIZED_MISSION_PROFILE_STATES = ['opt-in', 'canary', 'default'] as const;

export const SPECIALIZED_MISSION_PROFILE_BINDING_STATES = [
  'draft',
  'shadow',
  ...SPECIALIZED_MISSION_PROFILE_STATES,
] as const;

export const ACTIVE_STATE_SET = new Set<string>(SPECIALIZED_MISSION_PROFILE_STATES);

export const ACTIVE_STATE_RANK: Readonly<Record<SpecializedMissionProfileState, number>> = {
  'opt-in': 1,
  canary: 2,
  default: 3,
};

export const BINDING_START = '<robb-specialized-profile-binding>';

export const BINDING_END = '</robb-specialized-profile-binding>';

export const SpecializedMissionProfileReferenceSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().min(1),
  profileVersion: z.number().int().positive(),
  selectedState: z.enum(SPECIALIZED_MISSION_PROFILE_BINDING_STATES),
  lifecycleEntryTransitionSequence: z.number().int().positive(),
  registryRevisionAtSelection: z.number().int().nonnegative(),
  registryHeadSha256AtSelection: z.string().regex(/^[a-f0-9]{64}$/),
  versionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  capabilityEnvelopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executionRouteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Present only for host-internal stage evaluation Missions. */
  evaluationStage: z.enum(['offline', 'shadow', 'opt-in', 'canary', 'regression']).optional(),
  evaluationCohortId: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((reference, ctx) => {
  if (reference.evaluationStage
    && SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[reference.evaluationStage] !== reference.selectedState) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluationStage'],
      message: 'Evaluation binding stage must match its exact lifecycle entry state',
    });
  }
  if (!reference.evaluationStage && !ACTIVE_STATE_SET.has(reference.selectedState)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedState'],
      message: 'Inactive specialized profile bindings are reserved for host evaluation Missions',
    });
  }
  if (Boolean(reference.evaluationStage) !== Boolean(reference.evaluationCohortId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluationCohortId'],
      message: 'Evaluation stage and host cohort id must be bound together',
    });
  }
});

export type SpecializedMissionProfileState = typeof SPECIALIZED_MISSION_PROFILE_STATES[number];

export type SpecializedMissionProfileReference = z.infer<typeof SpecializedMissionProfileReferenceSchema>;

export interface SpecializedMissionProfileBinding extends SpecializedMissionProfileReference {
  currentState: typeof SPECIALIZED_MISSION_PROFILE_BINDING_STATES[number];
  currentRegistryRevision: number;
  currentRegistryHeadSha256: string;
  provenance: SpecializedProfileProvenance;
  capabilityEnvelope: readonly SpecializedMissionCapability[];
}

export interface SpecializedMissionCapability {
  kind: 'skill' | 'tool' | 'source' | 'workspace-read' | 'workspace-write' | 'network' | 'external-mutation';
  name: string;
  /** Host-resolved immutable identity of the effective definition/scope. */
  identitySha256?: string;
  /** Host-only non-secret credential generation used for point-of-use leasing. */
  authorityBindingId?: string;
}

export interface SpecializedMissionSelectionContext {
  fields: Readonly<Record<string, unknown>>;
  capabilities: readonly SpecializedMissionCapability[];
  executionRouteSha256: string;
}

export interface SpecializedMissionProfileSelection {
  profile: AgentProfile;
  binding: SpecializedMissionProfileBinding;
}

export class SpecializedMissionProfileSelectionError extends Error {
  readonly code = 'SPECIALIZED_MISSION_PROFILE_SELECTION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SpecializedMissionProfileSelectionError';
  }
}

export function selectionError(profileId: string, reason: string): SpecializedMissionProfileSelectionError {
  return new SpecializedMissionProfileSelectionError(`Specialized Mission profile "${profileId}" ${reason}`);
}
