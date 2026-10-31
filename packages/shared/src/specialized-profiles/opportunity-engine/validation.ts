import { isUnknownArray } from '../../utils/json.ts';
import type { AgentProfileOpportunityThreshold, SpecializationCategoryThreshold, SpecializationOpportunityCategory, SpecializationOpportunityThresholdOverrides, SpecializationOpportunityThresholds } from './contracts.ts';
import { AGENT_THRESHOLD_KEYS, BASE_THRESHOLD_KEYS, CATEGORY_SET, DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS, SPECIALIZATION_OPPORTUNITY_CATEGORIES } from './contracts.ts';

export function resolveSpecializationOpportunityThresholds(
  overrides: SpecializationOpportunityThresholdOverrides = {},
): SpecializationOpportunityThresholds {
  assertPlainRecord(overrides, 'threshold overrides');
  assertNoUnknownKeys(overrides, CATEGORY_SET, 'threshold overrides');
  const resolved = {} as Record<SpecializationOpportunityCategory, SpecializationCategoryThreshold>;
  for (const category of SPECIALIZATION_OPPORTUNITY_CATEGORIES) {
    const override = overrides[category];
    if (override !== undefined) {
      assertPlainRecord(override, `${category} threshold`);
      assertNoUnknownKeys(
        override,
        category === 'agent-profile' ? AGENT_THRESHOLD_KEYS : BASE_THRESHOLD_KEYS,
        `${category} threshold`,
      );
    }
    const threshold = { ...DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS[category], ...override };
    validateBaseThreshold(category, threshold);
    if (category === 'agent-profile') {
      const boundaryKinds = (threshold as AgentProfileOpportunityThreshold).minimumBoundaryKinds;
      if (!Number.isInteger(boundaryKinds) || boundaryKinds < 1 || boundaryKinds > 3) {
        throw new Error('agent-profile.minimumBoundaryKinds must be an integer between 1 and 3');
      }
    }
    resolved[category] = threshold;
  }
  return resolved as SpecializationOpportunityThresholds;
}

function validateBaseThreshold(
  category: SpecializationOpportunityCategory,
  threshold: SpecializationCategoryThreshold,
): void {
  for (const key of ['minimumFamilyRootMissions', 'minimumSupportingRootMissions'] as const) {
    const value = threshold[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${category}.${key} must be a positive integer`);
    }
  }
  const rate = threshold.minimumSupportingRate;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`${category}.minimumSupportingRate must be between 0 and 1`);
  }
}

export function validateBoundedString(value: unknown, path: string, maximumLength: number): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${path} must be at most ${maximumLength} characters`);
  }
}

export function assertPlainRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isUnknownArray(value)) {
    throw new Error(`${path} must be a plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
}

export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unsupported field "${unknown[0]}"`);
}
