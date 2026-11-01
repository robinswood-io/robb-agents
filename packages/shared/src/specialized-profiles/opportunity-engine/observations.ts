import { isUnknownArray } from '../../utils/json.ts';
import type { DeduplicatedRootMission, RootMissionSpecializationObservation, SpecializationOpportunityCategory } from './contracts.ts';
import { OBSERVATION_KEYS, SIGNAL_SET } from './contracts.ts';
import { assertNoUnknownKeys, assertPlainRecord, validateBoundedString } from './validation.ts';

export function deduplicateRootMissionObservations(
  observations: readonly RootMissionSpecializationObservation[],
): DeduplicatedRootMission[] {
  if (!isUnknownArray(observations)) throw new Error('observations must be an array');
  const roots = new Map<string, DeduplicatedRootMission>();
  const keyByObservationId = new Map<string, string>();
  for (const [index, observation] of observations.entries()) {
    validateObservation(observation, index);
    const observationId = observation.observationId.trim();
    const normalizedFamily = normalizeIdentity(observation.family);
    const normalizedObjective = normalizeIdentity(observation.rootObjective);
    const key = `${normalizedFamily}\u0000${normalizedObjective}`;
    const previousKey = keyByObservationId.get(observationId);
    if (previousKey !== undefined && previousKey !== key) {
      throw new Error(`observationId "${observationId}" refers to more than one root mission`);
    }
    keyByObservationId.set(observationId, key);

    const existing = roots.get(key);
    if (existing) {
      existing.rawObservationCount += 1;
      existing.familyVariants.add(observation.family.trim());
      existing.observationIds.add(observationId);
      for (const signal of observation.signals) existing.signals.add(signal);
      continue;
    }
    roots.set(key, {
      key,
      normalizedFamily,
      familyVariants: new Set([observation.family.trim()]),
      observationIds: new Set([observationId]),
      signals: new Set(observation.signals),
      rawObservationCount: 1,
    });
  }
  return [...roots.values()].sort((left, right) => lexical(left.key, right.key));
}

function validateObservation(
  observation: RootMissionSpecializationObservation,
  index: number,
): void {
  assertPlainRecord(observation, `observation[${index}]`);
  assertNoUnknownKeys(observation, OBSERVATION_KEYS, `observation[${index}]`);
  validateBoundedString(observation.observationId, `observation[${index}].observationId`, 200);
  validateBoundedString(observation.rootObjective, `observation[${index}].rootObjective`, 2_000);
  validateBoundedString(observation.family, `observation[${index}].family`, 200);
  if (!isUnknownArray(observation.signals)) {
    throw new Error(`observation[${index}].signals must be an array`);
  }
  for (const signal of observation.signals) {
    if (typeof signal !== 'string' || !SIGNAL_SET.has(signal)) {
      throw new Error(`observation[${index}].signals contains unsupported signal "${String(signal)}"`);
    }
  }
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function canonicalFamily(roots: readonly DeduplicatedRootMission[]): string {
  return sortedStrings(new Set(roots.flatMap((root) => [...root.familyVariants])))[0]!;
}

export function sortedEntries<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map.entries()].sort(([left], [right]) => lexical(left, right));
}

export function sortedStrings(values: ReadonlySet<string>): string[] {
  return [...values].sort(lexical);
}

export function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function passFail(passed: boolean): 'pass' | 'fail' {
  return passed ? 'pass' : 'fail';
}

export function formatRate(rate: number): string {
  return rate.toFixed(3);
}

export function proposalId(
  normalizedFamily: string,
  category: SpecializationOpportunityCategory,
): string {
  const slug = normalizedFamily
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48) || 'family';
  return `specialization:${category}:${slug}:${stableHash(normalizedFamily)}`;
}

/** Non-cryptographic, deterministic identifier suffix; never used as proof. */
function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ unit, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}
