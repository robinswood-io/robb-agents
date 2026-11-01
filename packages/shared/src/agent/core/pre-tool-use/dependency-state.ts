import type { PendingThirdPartyDependency } from './dependency-guards.ts';

export const observedThirdPartyDependencies = new Map<string, {
  expiresAt: number;
  objectiveFingerprint: string;
  dependencies: PendingThirdPartyDependency[];
}>();

export const observedResolvedThirdPartyDependencies = new Map<string, {
  expiresAt: number;
  objectiveFingerprint: string;
  dependencies: PendingThirdPartyDependency[];
}>();
