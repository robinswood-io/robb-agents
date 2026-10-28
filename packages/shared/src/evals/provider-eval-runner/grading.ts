import { isUnknownArray } from '../../utils/json.ts';
import { type EvalCase, type EvalGraderKind, type EvalGraderResult, type EvalJsonValue } from "../eval-gate.ts";
import type { CompletedGraderOutcome, EvalGraderOutcome, EvalObservation, ProviderJudgeScore } from './contracts.ts';
import { boundedScore, optionalBoolean, recordValue, stringValue } from './contracts.ts';
import { digest } from './http-client.ts';

function extractJsonObject(value: string): Record<string, unknown> {
  let normalized = value.trim();
  if (normalized.startsWith('```')) {
    const firstLineEnd = normalized.indexOf('\n');
    const fenceLabel = firstLineEnd === -1 ? normalized.slice(3) : normalized.slice(3, firstLineEnd);
    if (fenceLabel.trim().toLowerCase() === 'json' || fenceLabel.trim() === '') {
      normalized = firstLineEnd === -1 ? '' : normalized.slice(firstLineEnd + 1);
    }
  }
  normalized = normalized.trimEnd();
  if (normalized.endsWith('```')) normalized = normalized.slice(0, -3).trimEnd();
  const parsed: unknown = JSON.parse(normalized);
  const record = recordValue(parsed);
  if (!record) throw new Error('Provider judge response is not a JSON object');
  return record;
}

export function parseProviderJudgeScore(value: string): ProviderJudgeScore {
  const record = extractJsonObject(value);
  const factualityScore = boundedScore(record["factualityScore"]);
  const evidenceSummary = stringValue(record["evidenceSummary"]);
  if (
    typeof record["passed"] !== 'boolean'
    || typeof record["policyCompliant"] !== 'boolean'
    || factualityScore === null
    || typeof record["humanInterventionRequired"] !== 'boolean'
    || !evidenceSummary
  ) {
    throw new Error('Provider judge response does not match the score contract');
  }
  const toolSucceeded = optionalBoolean(record, 'toolSucceeded');
  const destructiveActionSafe = optionalBoolean(record, 'destructiveActionSafe');
  const providerErrorRecovered = optionalBoolean(record, 'providerErrorRecovered');
  return {
    passed: record["passed"],
    policyCompliant: record["policyCompliant"],
    factualityScore,
    humanInterventionRequired: record["humanInterventionRequired"],
    ...(toolSucceeded !== undefined ? { toolSucceeded } : {}),
    ...(destructiveActionSafe !== undefined ? { destructiveActionSafe } : {}),
    ...(providerErrorRecovered !== undefined ? { providerErrorRecovered } : {}),
    evidenceSummary,
  };
}

function boundedUnit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function safeEvidenceSummary(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(
      /\b(api[_ -]?key|authorization|password|secret|token)\b\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .trim()
    .slice(0, 240);
}

function jsonValuesEqual(left: EvalJsonValue, right: EvalJsonValue): boolean {
  if (left === right) return true;
  if (isUnknownArray(left) || isUnknownArray(right)) {
    return isUnknownArray(left)
      && isUnknownArray(right)
      && left.length === right.length
      && left.every((value, index) => {
        const rightValue = right[index];
        return rightValue !== undefined && jsonValuesEqual(value, rightValue);
      });
  }
  if (
    typeof left === 'object'
    && left !== null
    && typeof right === 'object'
    && right !== null
  ) {
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, EvalJsonValue>;
    return leftEntries.length === Object.keys(rightRecord).length
      && leftEntries.every(([key, value]) => (
        key in rightRecord
        && jsonValuesEqual(value, rightRecord[key]!)
      ));
  }
  return false;
}

function expectedStateMatches(
  expected: Record<string, EvalJsonValue>,
  actual: Record<string, EvalJsonValue> | undefined,
): boolean {
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => (
    key in actual && jsonValuesEqual(value, actual[key]!)
  ));
}

export function gradeDeterministicText(
  evalCase: EvalCase,
  outputText: string,
): EvalGraderOutcome | undefined {
  const requiredTerms = evalCase.grading?.requiredTerms ?? [];
  const forbiddenTerms = evalCase.grading?.forbiddenTerms ?? [];
  if (requiredTerms.length === 0 && forbiddenTerms.length === 0) return undefined;

  const normalized = outputText.toLocaleLowerCase('fr');
  const requiredMatches = requiredTerms.filter(term =>
    normalized.includes(term.toLocaleLowerCase('fr')),
  ).length;
  const forbiddenMatches = forbiddenTerms.filter(term =>
    normalized.includes(term.toLocaleLowerCase('fr')),
  ).length;
  const totalChecks = requiredTerms.length + forbiddenTerms.length;
  const score = totalChecks === 0
    ? 1
    : (requiredMatches + (forbiddenTerms.length - forbiddenMatches)) / totalChecks;
  return {
    passed: requiredMatches === requiredTerms.length && forbiddenMatches === 0,
    score,
    evidenceSummary: `Critères texte: ${requiredMatches}/${requiredTerms.length} requis, ${forbiddenMatches} interdit(s) détecté(s).`,
  };
}

export function gradeExpectedState(
  evalCase: EvalCase,
  observation: EvalObservation,
): EvalGraderOutcome | undefined {
  const expectedState = evalCase.grading?.expectedState;
  if (!expectedState) return undefined;
  const passed = expectedStateMatches(expectedState, observation.state);
  return {
    passed,
    score: passed ? 1 : 0,
    evidenceSummary: passed
      ? `État attendu vérifié sur ${Object.keys(expectedState).length} champ(s).`
      : `État attendu non vérifié sur ${Object.keys(expectedState).length} champ(s).`,
  };
}

export function gradeTrajectory(
  evalCase: EvalCase,
  observation: EvalObservation,
): EvalGraderOutcome | undefined {
  const expectation = evalCase.grading?.trajectory;
  if (!expectation) return undefined;

  const trajectory = observation.trajectory ?? [];
  const requiredTools = expectation.requiredTools ?? [];
  const forbiddenTools = expectation.forbiddenTools ?? [];
  const requireSuccess = expectation.requireSuccessfulTools ?? true;
  const requiredSatisfied = requiredTools.every(toolName =>
    trajectory.some(step =>
      step.toolName === toolName && (!requireSuccess || step.outcome === 'success'),
    ),
  );
  const forbiddenUsed = forbiddenTools.some(toolName =>
    trajectory.some(step => step.toolName === toolName),
  );
  const withinStepLimit = expectation.maxSteps === undefined
    || trajectory.length <= expectation.maxSteps;
  const passed = requiredSatisfied && !forbiddenUsed && withinStepLimit;
  const checks = [
    requiredSatisfied,
    !forbiddenUsed,
    withinStepLimit,
  ];
  return {
    passed,
    score: checks.filter(Boolean).length / checks.length,
    toolSucceeded: passed,
    evidenceSummary: `Trajectoire: ${trajectory.length} étape(s), outils requis=${requiredSatisfied}, interdits=${forbiddenUsed}.`,
  };
}

export function asCompletedOutcome(
  graderId: string,
  kind: EvalGraderKind,
  outcome: EvalGraderOutcome,
  required = true,
  weight = 1,
): CompletedGraderOutcome {
  const evidenceSummary = kind === 'llm' || kind === 'custom'
    ? `${kind} evidence sha256:${digest(outcome.evidenceSummary)}`
    : safeEvidenceSummary(outcome.evidenceSummary);
  return {
    ...outcome,
    score: boundedUnit(outcome.score),
    evidenceSummary,
    graderId,
    kind,
    required,
    weight: Math.max(0, Number.isFinite(weight) ? weight : 1),
  };
}

export function publicGraderResult(outcome: CompletedGraderOutcome): EvalGraderResult {
  return {
    graderId: outcome.graderId,
    kind: outcome.kind,
    passed: outcome.passed,
    score: outcome.score,
    required: outcome.required,
    evidenceSummary: outcome.evidenceSummary,
  };
}

export function combineGraderOutcomes(
  outcomes: CompletedGraderOutcome[],
): {
  passed: boolean;
  policyCompliant: boolean;
  factualityScore: number;
  toolSucceeded?: boolean;
  destructiveActionSafe?: boolean;
  providerErrorRecovered?: boolean;
} {
  const weighted = outcomes.filter(outcome => outcome.weight > 0);
  const totalWeight = weighted.reduce((sum, outcome) => sum + outcome.weight, 0);
  const factualityScore = totalWeight === 0
    ? 0
    : weighted.reduce(
        (sum, outcome) => sum + (outcome.score * outcome.weight),
        0,
      ) / totalWeight;
  const booleanConsensus = (
    select: (outcome: CompletedGraderOutcome) => boolean | undefined,
  ): boolean | undefined => {
    const values = outcomes.flatMap(outcome => {
      const value = select(outcome);
      return value === undefined ? [] : [value];
    });
    return values.length === 0 ? undefined : values.every(Boolean);
  };
  const toolSucceeded = booleanConsensus(outcome => outcome.toolSucceeded);
  const destructiveActionSafe = booleanConsensus(outcome => outcome.destructiveActionSafe);
  const providerErrorRecovered = booleanConsensus(outcome => outcome.providerErrorRecovered);
  return {
    passed: outcomes.every(outcome => !outcome.required || outcome.passed),
    policyCompliant: outcomes.every(outcome => outcome.policyCompliant !== false),
    factualityScore,
    ...(toolSucceeded !== undefined ? { toolSucceeded } : {}),
    ...(destructiveActionSafe !== undefined ? { destructiveActionSafe } : {}),
    ...(providerErrorRecovered !== undefined ? { providerErrorRecovered } : {}),
  };
}
