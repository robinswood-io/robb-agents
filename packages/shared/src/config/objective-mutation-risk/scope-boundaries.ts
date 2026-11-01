import { detectHighStakesEvidenceDomain } from "../../agent/core/objective-evidence-gate.ts";
import { authoritativeMutationMatches } from './authoritative-actions.ts';
import { neutralizeNonCredentialObservationIdentifiers } from './observation-text.ts';
import { ACTION_ONLY_PREFIX_PATTERN, DECLARATIVE_CLAUSE_START_PATTERN, DIRECT_RBAC_DOMAIN_PATTERN, MUTATION_MODIFIER_ONLY_START_PATTERN, PRODUCTION_ENVIRONMENT_RISK_PATTERN, READ_ONLY_NOMINAL_OPERATION_START_PATTERN, READ_ONLY_OPERATION_START_PATTERN, SENSITIVE_DOMAIN_PATTERN, STRUCTURED_FIELD_DELIMITER_SOURCE, STRUCTURED_TARGET_FIELD_PATTERN } from './patterns.ts';

function normalizeClauseLead(text: string): string {
  return text.trimStart()
    .replace(/^(?:[,;:]\s*)+/u, '')
    .replace(/^(?:[-*+•]\s*)/u, '')
    .replace(new RegExp(
      String.raw`^(?:(?:action|operation|op[ée]ration|command|commande|task|t[âa]che|[àa]\s+faire)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*)`,
      'iu',
    ), '');
}

function operationStartsNearClauseBoundary(text: string): boolean {
  const normalized = normalizeClauseLead(text);
  const firstMutation = authoritativeMutationMatches(text)[0];
  return (firstMutation?.index ?? Number.POSITIVE_INFINITY) <= 24
    || READ_ONLY_OPERATION_START_PATTERN.test(normalized)
    || READ_ONLY_NOMINAL_OPERATION_START_PATTERN.test(normalized)
    || DECLARATIVE_CLAUSE_START_PATTERN.test(normalized)
    || /^(?:(?:the|this|that|a|le|ce|cet|cette|un)\s+)?(?:plan|document|report|rapport|text|texte|message|instruction|consigne)\b/iu.test(normalized);
}

function structuralDelimiterIndices(text: string, delimiter: string, from = 0): number[] {
  const indices: number[] = [];
  const quotePairs: Record<string, string> = { '"': '"', '“': '”', '«': '»', '`': '`' };
  let quoteClose: string | undefined;
  let escaped = false;
  let parenthesisDepth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoteClose) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && (quoteClose === '"' || quoteClose === '`')) {
        escaped = true;
      } else if (char === quoteClose) {
        quoteClose = undefined;
      }
      continue;
    }
    const closingQuote = quotePairs[char];
    if (closingQuote) {
      quoteClose = closingQuote;
      continue;
    }
    if (char === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (char === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (parenthesisDepth > 0 || char !== delimiter) continue;
    if (delimiter === '-' && !(/\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? ''))) {
      continue;
    }
    indices.push(index);
  }
  return indices;
}

function matchingParenthesisIndex(text: string): number {
  let depth = 0;
  const quotePairs: Record<string, string> = { '"': '"', '“': '”', '«': '»', '`': '`' };
  let quoteClose: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoteClose) {
      if (escaped) escaped = false;
      else if (char === '\\' && (quoteClose === '"' || quoteClose === '`')) escaped = true;
      else if (char === quoteClose) quoteClose = undefined;
      continue;
    }
    const closingQuote = quotePairs[char];
    if (closingQuote) {
      quoteClose = closingQuote;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function closedIntercalaryTails(text: string): string[] | undefined {
  const normalized = text.trimStart();
  if (normalized.startsWith('(')) {
    const closing = matchingParenthesisIndex(normalized);
    return closing < 0 ? undefined : [normalized.slice(closing + 1).trimStart()];
  }

  if (/^[—–-]/u.test(normalized)) {
    const opener = normalized[0]!;
    const closings = structuralDelimiterIndices(normalized, opener, 1);
    return closings.length === 0
      ? undefined
      : closings.map(closing => normalized.slice(closing + 1).trimStart());
  }

  if (!normalized.startsWith(',')) return undefined;
  const closings = structuralDelimiterIndices(normalized, ',', 1);
  return closings.length === 0
    ? undefined
    : closings.map(closing => normalized.slice(closing + 1).trimStart());
}

export function plainConjunctionStartsAnotherOperation(text: string): boolean {
  const intercalaryTails = closedIntercalaryTails(text);
  if (intercalaryTails !== undefined) {
    // With nested comma/dash content, fail closed for safety: every plausible
    // closing mark must leave a new operation before the governing mutation is
    // detached from the target that follows the aside.
    return intercalaryTails.length > 0 && intercalaryTails.every(tail => (
      tail.length > 0 && operationStartsNearClauseBoundary(tail)
    ));
  }

  // A bare leading adjunct may have a single comma rather than paired marks:
  // "after review, verify ...". Inspect only what follows that comma. If it
  // does not start an operation, the text is still the target/modifier of the
  // governing mutation ("after review, the API account").
  const normalized = text.trimStart();
  const commaTails = structuralDelimiterIndices(normalized, ',')
    .map(comma => normalized.slice(comma + 1).trimStart());
  if (commaTails.length > 0 && commaTails.every(tail => (
    tail.length > 0 && operationStartsNearClauseBoundary(tail)
  ))) {
    return true;
  }
  return operationStartsNearClauseBoundary(text);
}

export function mutationHasLocalTarget(text: string): boolean {
  let normalized = text.trim()
    .replace(/^(?:then|and\s+then|puis|ensuite)\b/iu, '')
    .replace(/^[\s.,:;…-]+/u, '')
    .trimStart();
  const intercalaryTails = closedIntercalaryTails(normalized);
  if (intercalaryTails !== undefined) {
    return intercalaryTails.some(tail => mutationHasLocalTarget(tail));
  }
  normalized = normalizeClauseLead(normalized)
    .replace(new RegExp(
      String.raw`^(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*`,
      'iu',
    ), '')
    .trim();
  return normalized.length > 0 && !MUTATION_MODIFIER_ONLY_START_PATTERN.test(normalized);
}

export function implicitPreverbalSensitiveTarget(
  authorityText: string,
  scopeStart: number,
  beforeMutation: string,
  afterMutation: string,
): string | undefined {
  if (!ACTION_ONLY_PREFIX_PATTERN.test(beforeMutation)
    || !/^[\s.!?;:…]*$/u.test(afterMutation)) return undefined;
  const previousText = authorityText.slice(0, scopeStart).trim();
  const structuredTargets = [...previousText.matchAll(STRUCTURED_TARGET_FIELD_PATTERN)];
  const structuredTarget = structuredTargets.at(-1)?.[1]?.trim();
  const previousClause = previousText
    .split(/[.!?;\n]+/u)
    .map(part => part.trim())
    .filter(Boolean)
    .at(-1);
  if ((!structuredTarget && !previousClause) || (previousClause?.length ?? 0) > 200) return undefined;
  const candidate = structuredTarget ?? previousClause!.replace(new RegExp(
    String.raw`^(?:[-*+•]\s*)?(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*`,
    'iu',
  ), '');
  const riskCandidate = neutralizeNonCredentialObservationIdentifiers(candidate);
  return SENSITIVE_DOMAIN_PATTERN.test(riskCandidate)
    || DIRECT_RBAC_DOMAIN_PATTERN.test(riskCandidate)
    || PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(riskCandidate)
    || detectHighStakesEvidenceDomain(riskCandidate) !== undefined
    ? candidate
    : undefined;
}

export function boundedReferentContext(text: string, maxChars = 8_192): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  return `${text.slice(0, headChars)}\n${text.slice(-tailChars)}`;
}
