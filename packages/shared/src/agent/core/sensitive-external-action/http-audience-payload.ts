import { uniqueTargets } from './action-targets.ts';
import { isHttpExternalAudienceField, isKnownHttpExternalSendNonAudienceField, resemblesUnknownExternalAudienceField } from './http-audience-fields.ts';
import type { SensitiveConditionalTarget, SensitiveConditionalTargetKind } from './types.ts';

export function extractLiteralBusinessTargets(command: string): string[] {
  const emails = [...command.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)]
    .map(match => match[0]);
  const ids = [...command.matchAll(
    /["']?(?:(?:account|contract|customer|document|envelope|message|recipient|request|signatory|user)[_-]?id|id)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)/gi,
  )].map(match => match[1]);
  const commitments = [...command.matchAll(
    /["']?(?:amount|beneficiary|counterparty|currency|customer)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)/gi,
  )].map(match => match[1]);
  return uniqueTargets([...emails, ...ids, ...commitments]);
}

export const HTTP_CONDITIONAL_TARGET_FIELDS: Readonly<Record<string, SensitiveConditionalTargetKind>> = {
  contract: 'contract',
  contract_id: 'contract',
  document: 'document',
  document_id: 'document',
  envelope: 'envelope',
  envelope_id: 'envelope',
};

export interface HttpExternalSendTargets {
  audienceTargets: string[];
  conditionalTargets: SensitiveConditionalTarget[];
  resolved: boolean;
}

export interface HttpExternalSendAccumulator {
  audienceTargets: string[];
  conditionalTargets: SensitiveConditionalTarget[];
  resolved: boolean;
  sawAudience: boolean;
  visitedNodes: number;
}

export function normalizedPayloadFieldName(value: string): string | undefined {
  const decoded = decodedLiteralValue(value);
  if (decoded === undefined) return undefined;
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function hasDynamicShellValue(value: string): boolean {
  return value.includes('${') || value.includes('$(') || value.includes('`')
    || /\$[A-Za-z_0-9@*#?$!-]/.test(value);
}

function decodedLiteralValue(value: string): string | undefined {
  if (hasDynamicShellValue(value) || /[\0\r\n*?[\]{}~]/.test(value)
    || /%(?![0-9A-Fa-f]{2})/.test(value)) {
    return undefined;
  }
  try {
    let decoded = value;
    for (let pass = 0; pass < 3 && /%[0-9A-Fa-f]{2}/.test(decoded); pass += 1) {
      decoded = decodeURIComponent(decoded);
      if (/%(?![0-9A-Fa-f]{2})/.test(decoded)) return undefined;
    }
    return hasDynamicShellValue(decoded) || /[\0\r\n*?[\]{}~]/.test(decoded) ? undefined : decoded;
  } catch {
    return undefined;
  }
}

export function literalAudienceValues(value: unknown, field: string): { values: string[]; resolved: boolean } {
  if (Array.isArray(value)) {
    const entries = value.map(entry => literalAudienceValues(entry, field));
    return {
      values: entries.flatMap(entry => entry.values),
      resolved: entries.length > 0 && entries.every(entry => entry.resolved),
    };
  }
  if (value && typeof value === 'object') {
    const identifierFields = new Set([
      'id', 'email', 'email_address', 'address', 'phone', 'phone_number', 'number',
      'username', 'name', 'value',
    ]);
    const candidates = Object.entries(value)
      .map(([rawKey, entry]) => ({ key: normalizedPayloadFieldName(rawKey), entry }));
    const unknownField = candidates.some(candidate => !candidate.key || !identifierFields.has(candidate.key));
    const entries = candidates
      .filter((candidate): candidate is { key: string; entry: unknown } =>
        !!candidate.key && identifierFields.has(candidate.key)
      )
      .map(candidate => literalAudienceValues(candidate.entry, `${field}_${candidate.key}`));
    return {
      values: entries.flatMap(entry => entry.values),
      resolved: !unknownField && entries.length > 0 && entries.every(entry => entry.resolved),
    };
  }
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    return { values: [], resolved: false };
  }

  const decoded = decodedLiteralValue(String(value).trim());
  if (!decoded) return { values: [], resolved: false };
  const emails = [...decoded.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)]
    .map(match => match[0]);
  if (emails.length > 0) return { values: uniqueTargets(emails), resolved: true };
  if (field.includes('email')) return { values: [], resolved: false };

  const values = decoded
    .split(/[;,]/)
    .map(entry => entry.trim())
    .filter(Boolean);
  const resolved = values.length > 0 && values.every(entry =>
    entry.length <= 200 && !hasDynamicShellValue(entry) && !/[\0\r\n]/.test(entry)
  );
  return { values: resolved ? values : [], resolved };
}

export function literalConditionalValues(
  value: unknown,
  kind: SensitiveConditionalTargetKind,
): { values: SensitiveConditionalTarget[]; resolved: boolean } {
  if (Array.isArray(value)) {
    const entries = value.map(entry => literalConditionalValues(entry, kind));
    return {
      values: entries.flatMap(entry => entry.values),
      resolved: entries.length > 0 && entries.every(entry => entry.resolved),
    };
  }
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    return { values: [], resolved: false };
  }
  const decoded = decodedLiteralValue(String(value).trim());
  if (!decoded || decoded.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(decoded)) {
    return { values: [], resolved: false };
  }
  return { values: [{ kind, value: decoded }], resolved: true };
}

function collectHttpExternalSendPayload(
  value: unknown,
  accumulator: HttpExternalSendAccumulator,
  depth = 0,
): void {
  accumulator.visitedNodes += 1;
  if (depth > 8 || accumulator.visitedNodes > 1_024) {
    accumulator.resolved = false;
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHttpExternalSendPayload(entry, accumulator, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [rawKey, entry] of Object.entries(value)) {
    const key = normalizedPayloadFieldName(rawKey);
    if (!key) {
      accumulator.resolved = false;
      continue;
    }
    const audienceField = isHttpExternalAudienceField(key);
    if (audienceField) {
      accumulator.sawAudience = true;
      const literal = literalAudienceValues(entry, key);
      accumulator.audienceTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    } else if (resemblesUnknownExternalAudienceField(key)) {
      accumulator.resolved = false;
    }
    const conditionalKind = HTTP_CONDITIONAL_TARGET_FIELDS[key];
    if (conditionalKind) {
      const literal = literalConditionalValues(entry, conditionalKind);
      accumulator.conditionalTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    }
    if (!audienceField && !conditionalKind && !isKnownHttpExternalSendNonAudienceField(key)
      && (Array.isArray(entry) || !entry || typeof entry !== 'object')) {
      accumulator.resolved = false;
    }
    if (!audienceField && entry && typeof entry === 'object') {
      collectHttpExternalSendPayload(entry, accumulator, depth + 1);
    }
  }
}

export function collectEmailsFromLiteral(
  value: string,
  accumulator: HttpExternalSendAccumulator,
): void {
  const decoded = decodedLiteralValue(value);
  // This is a best-effort backstop for literal addresses in custom fields.
  // Resolution is decided by known audience fields, not unrelated body text.
  if (decoded === undefined) return;
  const emails = [...decoded.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)]
    .map(match => match[0]);
  if (emails.length > 0) {
    accumulator.sawAudience = true;
    accumulator.audienceTargets.push(...emails);
  }
}

export function collectConditionalTargetsFromHttpPath(
  pathname: string,
  accumulator: HttpExternalSendAccumulator,
): void {
  const segments = pathname.split('/').filter(Boolean);
  const pathKinds: Readonly<Record<string, SensitiveConditionalTargetKind>> = {
    contract: 'contract',
    contracts: 'contract',
    contrat: 'contract',
    contrats: 'contract',
    document: 'document',
    documents: 'document',
    envelope: 'envelope',
    envelopes: 'envelope',
    enveloppe: 'envelope',
    enveloppes: 'envelope',
  };
  for (let index = 0; index < segments.length; index += 1) {
    const rawSegment = segments[index]!;
    const decodedSegment = decodedLiteralValue(rawSegment);
    if (decodedSegment === undefined) {
      accumulator.resolved = false;
      continue;
    }
    const kind = pathKinds[decodedSegment.toLowerCase()];
    if (!kind) continue;
    const rawValue = segments[index + 1];
    const literal = rawValue === undefined
      ? { values: [], resolved: false }
      : literalConditionalValues(rawValue, kind);
    accumulator.conditionalTargets.push(...literal.values);
    if (!literal.resolved) accumulator.resolved = false;
  }
}

export function parseHttpExternalSendPayload(
  rawPayload: string,
  accumulator: HttpExternalSendAccumulator,
): void {
  const trimmed = rawPayload.trim();
  if (!trimmed || trimmed === '@-' || trimmed.startsWith('@') || /^[^=]+=[@<]/.test(trimmed)) {
    accumulator.resolved = false;
    return;
  }
  if (hasDynamicShellValue(trimmed)) {
    accumulator.resolved = false;
    return;
  }

  let jsonCandidate = trimmed;
  if (!/^[{[]/.test(jsonCandidate)) {
    const decoded = decodedLiteralValue(jsonCandidate);
    if (decoded && /^[{[]/.test(decoded.trim())) jsonCandidate = decoded.trim();
  }
  if (/^[{[]/.test(jsonCandidate)) {
    try {
      const parsed = JSON.parse(jsonCandidate) as unknown;
      collectHttpExternalSendPayload(parsed, accumulator);
      collectEmailsFromLiteral(jsonCandidate, accumulator);
    } catch {
      accumulator.resolved = false;
    }
    return;
  }

  if (!trimmed.includes('=')) {
    collectEmailsFromLiteral(trimmed, accumulator);
    accumulator.resolved = false;
    return;
  }
  const params = new URLSearchParams(trimmed);
  let sawEntry = false;
  for (const [rawKey, entry] of params.entries()) {
    sawEntry = true;
    const key = normalizedPayloadFieldName(rawKey);
    if (!key) {
      accumulator.resolved = false;
      continue;
    }
    const audienceField = isHttpExternalAudienceField(key);
    if (audienceField) {
      accumulator.sawAudience = true;
      const literal = literalAudienceValues(entry, key);
      accumulator.audienceTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    } else if (resemblesUnknownExternalAudienceField(key)) {
      accumulator.resolved = false;
    }
    const conditionalKind = HTTP_CONDITIONAL_TARGET_FIELDS[key];
    if (conditionalKind) {
      const literal = literalConditionalValues(entry, conditionalKind);
      accumulator.conditionalTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    }
    if (!audienceField && !conditionalKind && !isKnownHttpExternalSendNonAudienceField(key)) {
      accumulator.resolved = false;
    }
    collectEmailsFromLiteral(entry, accumulator);
  }
  if (!sawEntry) accumulator.resolved = false;
}
