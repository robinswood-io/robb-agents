import { createHash } from "node:crypto";
import type { SpecializedProfileHumanApprovalReceipt } from './approval.ts';
import type { SpecializedAgentProfileDefinition, SpecializedProfileState } from './profile-definition.ts';
import { SpecializedAgentProfileDefinitionSchema } from './profile-definition.ts';
import type { SpecializedProfileProvenance } from './profile-provenance.ts';
import { SpecializedProfileVersionSchema } from './profile-provenance.ts';
import { SpecializedProfileRegistryAnchorPayloadSchema, SpecializedProfileRegistryPayloadSchema } from './registry.ts';

export interface CreateSpecializedProfileCandidateInput {
  profileId: string;
  creationRequestId: string;
  definition: SpecializedAgentProfileDefinition;
  provenance: SpecializedProfileProvenance;
  actorId: string;
  reason: string;
}

export interface ReviseSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  definition: SpecializedAgentProfileDefinition;
  provenance: SpecializedProfileProvenance;
  actorId: string;
  reason: string;
}

export interface TransitionSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  to: SpecializedProfileState;
  actorId: string;
  reason: string;
  evaluationIds?: string[];
  approvalReceipt?: SpecializedProfileHumanApprovalReceipt;
}

export interface RollbackSpecializedProfileInput {
  profileId: string;
  expectedCurrentVersion: number;
  rollbackOfVersion: number;
  actorId: string;
  reason: string;
}

export function canonicalSpecializedProfileDefinitionHash(value: unknown): string {
  return sha256(canonicalJson(SpecializedAgentProfileDefinitionSchema.parse(value)));
}

export function canonicalSpecializedProfileVersionHash(value: unknown): string {
  return sha256(canonicalJson(SpecializedProfileVersionSchema.parse(value)));
}

export function canonicalSpecializedProfileRegistryPayloadHash(value: unknown): string {
  const candidate = value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'head'))
    : value;
  return sha256(canonicalJson(SpecializedProfileRegistryPayloadSchema.parse(candidate)));
}

export function canonicalSpecializedProfileRegistryAnchorPayloadHash(value: unknown): string {
  const candidate = value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'authority'))
    : value;
  const parsed = SpecializedProfileRegistryAnchorPayloadSchema.parse(candidate);
  return sha256(canonicalJson(parsed));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
