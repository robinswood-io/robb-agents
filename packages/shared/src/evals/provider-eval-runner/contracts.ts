import { isUnknownArray } from '../../utils/json.ts';
import { type EvalCase, type EvalGraderKind, type EvalJsonValue } from "../eval-gate.ts";

export type LiveEvalProvider =
  | 'anthropic-messages'
  | 'google-gemini'
  | 'openai-chat'
  | 'openai-responses';

export type ProviderEvalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderPricing {
  catalogVersion: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface ProviderEvalClientConfig {
  provider: LiveEvalProvider;
  model: string;
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  pricing?: ProviderPricing;
}

export interface ProviderEvalResponse {
  provider: LiveEvalProvider;
  model: string;
  requestId?: string;
  outputText: string;
  outputDigest: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  pricingCatalogVersion?: string;
}

export interface ProviderJudgeScore {
  passed: boolean;
  policyCompliant: boolean;
  factualityScore: number;
  humanInterventionRequired: boolean;
  toolSucceeded?: boolean;
  destructiveActionSafe?: boolean;
  providerErrorRecovered?: boolean;
  evidenceSummary: string;
}

export interface EvalTrajectoryStep {
  toolName: string;
  outcome: 'success' | 'failed' | 'cancelled';
}

export interface EvalObservation {
  state?: Record<string, EvalJsonValue>;
  trajectory?: EvalTrajectoryStep[];
}

export type EvalObservationProvider = (
  evalCase: EvalCase,
  response: ProviderEvalResponse,
  repetition: number,
) => EvalObservation | Promise<EvalObservation>;

export interface EvalGraderContext {
  evalCase: EvalCase;
  response: ProviderEvalResponse;
  observation: EvalObservation;
  repetition: number;
}

export interface EvalGraderOutcome {
  passed: boolean;
  score: number;
  evidenceSummary: string;
  policyCompliant?: boolean;
  toolSucceeded?: boolean;
  destructiveActionSafe?: boolean;
  providerErrorRecovered?: boolean;
}

export interface EvalGrader {
  id: string;
  kind: EvalGraderKind;
  required?: boolean;
  weight?: number;
  grade(context: EvalGraderContext): EvalGraderOutcome | Promise<EvalGraderOutcome>;
}

export interface CompletedGraderOutcome extends EvalGraderOutcome {
  graderId: string;
  kind: EvalGraderKind;
  required: boolean;
  weight: number;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !isUnknownArray(value)
    ? Object.fromEntries(Object.entries<unknown>((value as Record<string, unknown>)))
    : null;
}

export function arrayValue(value: unknown): unknown[] {
  return isUnknownArray(value) ? value : [];
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function boundedScore(value: unknown): number | null {
  const score = finiteNumber(value);
  return score !== null && score >= 0 && score <= 1 ? score : null;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export interface EvalJob {
  evalCase: EvalCase;
  repetition: number;
}
