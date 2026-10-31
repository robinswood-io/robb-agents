import { z } from "zod";

export const SPECIALIZED_PROFILE_REGISTRY_SCHEMA_VERSION = 2 as const;

export const SPECIALIZED_PROFILE_VERSION_SCHEMA_VERSION = 1 as const;

export const SPECIALIZED_PROFILE_REGISTRY_HEAD_SCHEMA_VERSION = 1 as const;

export const SPECIALIZED_PROFILE_REGISTRY_ANCHOR_SCHEMA_VERSION = 1 as const;

export const SPECIALIZED_PROFILE_STATES = [
  'candidate',
  'draft',
  'shadow',
  'opt-in',
  'canary',
  'default',
  'retired',
  'revoked',
] as const;

export const SPECIALIZED_PROFILE_EVALUATION_STAGES = [
  'offline',
  'shadow',
  'opt-in',
  'canary',
  'regression',
] as const;

export const SPECIALIZED_PROFILE_MIN_EVALUATION_CASES = 20 as const;

export const SPECIALIZED_PROFILE_ALLOWED_TRANSITIONS = Object.freeze({
  candidate: ['draft', 'revoked'],
  draft: ['shadow', 'retired', 'revoked'],
  shadow: ['draft', 'opt-in', 'retired', 'revoked'],
  'opt-in': ['shadow', 'canary', 'retired', 'revoked'],
  canary: ['opt-in', 'default', 'retired', 'revoked'],
  default: ['canary', 'retired', 'revoked'],
  retired: ['draft', 'revoked'],
  revoked: [],
} satisfies Record<
  (typeof SPECIALIZED_PROFILE_STATES)[number],
  readonly (typeof SPECIALIZED_PROFILE_STATES)[number][]
>);

export const SPECIALIZED_PROFILE_REQUIRED_EVALUATION_STAGE: Readonly<
  Partial<Record<(typeof SPECIALIZED_PROFILE_STATES)[number], (typeof SPECIALIZED_PROFILE_EVALUATION_STAGES)[number]>>
> = Object.freeze({
  shadow: 'offline',
  'opt-in': 'shadow',
  canary: 'opt-in',
  default: 'canary',
});

const SPECIALIZED_PROFILE_PROMOTION_RANK: Readonly<Partial<Record<SpecializedProfileState, number>>> = {
  candidate: 0,
  draft: 1,
  shadow: 2,
  'opt-in': 3,
  canary: 4,
  default: 5,
};

export function specializedProfileTransitionIsPromotion(
  from: SpecializedProfileState,
  to: SpecializedProfileState,
): boolean {
  const fromRank = SPECIALIZED_PROFILE_PROMOTION_RANK[from];
  const toRank = SPECIALIZED_PROFILE_PROMOTION_RANK[to];
  return fromRank !== undefined && toRank !== undefined && toRank > fromRank;
}

export const SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE: Readonly<
  Record<
    (typeof SPECIALIZED_PROFILE_EVALUATION_STAGES)[number],
    (typeof SPECIALIZED_PROFILE_STATES)[number]
  >
> = Object.freeze({
  offline: 'draft',
  shadow: 'shadow',
  'opt-in': 'opt-in',
  canary: 'canary',
  regression: 'default',
});

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

const CONDITION_FIELD_RE = /^[a-z][a-z0-9_.-]{0,127}$/;

export const SHA256_RE = /^[a-f0-9]{64}$/;

export const profileId = z.string().regex(
  PROFILE_ID_RE,
  'Profile id must be a lowercase slug (a-z, 0-9, hyphens)',
);

export const identifier = (label: string) => z.string().trim().min(1, `${label} is required`).max(256);

export const timestamp = z.string().datetime({ offset: true });

export const SpecializedProfileStateSchema = z.enum(SPECIALIZED_PROFILE_STATES);

export type SpecializedProfileState = z.infer<typeof SpecializedProfileStateSchema>;

export const SpecializedProfileConditionSchema = z.object({
  id: profileId,
  description: z.string().trim().min(1).max(2_000),
  field: z.string().regex(CONDITION_FIELD_RE),
  operator: z.enum(['equals', 'includes', 'matches', 'present']),
  value: z.string().trim().min(1).max(1_024).optional(),
}).strict().superRefine((condition, ctx) => {
  if (condition.operator !== 'present' && condition.value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `${condition.operator} requires a value`,
    });
  }
  if (condition.operator === 'present' && condition.value !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'present must not declare a value',
    });
  }
});

export type SpecializedProfileCondition = z.infer<typeof SpecializedProfileConditionSchema>;

export const SpecializedProfileRequestedCapabilitySchema = z.object({
  id: profileId,
  kind: z.enum([
    'skill',
    'tool',
    'source',
    'workspace-read',
    'workspace-write',
    'network',
    'external-mutation',
  ]),
  name: z.string().trim().min(1).max(256),
  justification: z.string().trim().min(1).max(2_000),
  required: z.boolean(),
}).strict();

export type SpecializedProfileRequestedCapability = z.infer<typeof SpecializedProfileRequestedCapabilitySchema>;

export const SpecializedAgentProfileDefinitionSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
  role: z.enum(['planner', 'worker', 'reviewer', 'supervisor']),
  specialty: z.string().trim().min(1).max(512),
  objective: z.string().trim().min(1).max(4_000),
  systemPrompt: z.string().trim().min(1).max(64_000),
  riskClass: z.enum(['low', 'moderate', 'high', 'critical']),
  eligibilityCriteria: z.array(SpecializedProfileConditionSchema).min(1).max(64),
  abstentionCriteria: z.array(SpecializedProfileConditionSchema).min(1).max(64),
  requestedCapabilities: z.array(SpecializedProfileRequestedCapabilitySchema).max(64).default([]),
  successCriteria: z.array(z.object({
    id: profileId,
    description: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(64),
}).strict().superRefine((definition, ctx) => {
  for (const [field, values] of [
    ['eligibilityCriteria', definition.eligibilityCriteria],
    ['abstentionCriteria', definition.abstentionCriteria],
    ['requestedCapabilities', definition.requestedCapabilities],
    ['successCriteria', definition.successCriteria],
  ] as const) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, 'id'],
          message: `${field} ids must be unique`,
        });
      }
      seen.add(value.id);
    });
  }
});

export type SpecializedAgentProfileDefinition = z.infer<typeof SpecializedAgentProfileDefinitionSchema>;

export const SpecializedProfileSourceRefSchema = z.object({
  kind: z.enum(['session', 'mission', 'artifact', 'evaluation', 'manual']),
  sourceId: identifier('Source id').optional(),
  uri: z.string().trim().min(1).max(2_048).optional(),
  sha256: z.string().regex(SHA256_RE),
  redacted: z.literal(true),
}).strict().refine((source) => source.sourceId !== undefined || source.uri !== undefined, {
  message: 'A provenance source requires sourceId or uri',
});

export type SpecializedProfileSourceRef = z.infer<typeof SpecializedProfileSourceRefSchema>;
