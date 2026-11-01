import { isUnknownArray } from '../../../utils/json.ts';
import { ADDITIONAL_UNRESOLVED_TARGETS, TARGET_FIELD_NAMES, UNRESOLVED_EXTERNAL_TARGET, hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { isHttpExternalAudienceField, isKnownHttpExternalSendNonAudienceField, resemblesUnknownExternalAudienceField } from './http-audience-fields.ts';
import { hasBoundedSessionPdfAttachment, isCanonicalEmailAddress } from './target-syntax.ts';

export function uniqueTargets(values: Array<string | undefined>): string[] {
  const maxConcreteTargets = 64;
  let rejectedConcreteTarget = false;
  const targets = values
    .map(value => {
      const trimmed = value?.trim();
      if (trimmed && trimmed.length > 200) rejectedConcreteTarget = true;
      return trimmed;
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200);
  const unique = [...new Set(targets)];
  if (rejectedConcreteTarget || unique.length > maxConcreteTargets) {
    return [...unique.slice(0, maxConcreteTargets), ADDITIONAL_UNRESOLVED_TARGETS];
  }
  return unique;
}

function extractCanonicalGmailSendTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  let unresolved = false;
  const appendAudience = (value: unknown): void => {
    if (typeof value !== 'string') {
      unresolved = true;
      return;
    }
    if (value && hasDynamicOrGlobTargetSyntax(value)) {
      unresolved = true;
      return;
    }
    targets.push(value);
  };

  for (const [key, value] of Object.entries(input)) {
    if (key === '_intent' || key === '_displayName') {
      if (typeof value !== 'string' || /\0/u.test(value)) unresolved = true;
      continue;
    }
    if (key === 'to' || key === 'cc' || key === 'bcc') {
      appendAudience(value);
      continue;
    }
    if (key === 'subject') {
      if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) unresolved = true;
      continue;
    }
    if (key === 'body') {
      if (typeof value !== 'string' || /\0/u.test(value)) unresolved = true;
      continue;
    }
    if (key === 'sendAsEmail') {
      // An omitted optional JSON property is fine. Once the key is present,
      // its value must remain one literal canonical email address; aliases,
      // undefined values and display-name forms stay unresolved.
      if (!isCanonicalEmailAddress(value)) unresolved = true;
      continue;
    }
    if (key === 'isHtml'
      || key === 'requireKnownContacts'
      || key === 'allowExternal'
      || key === 'checkContacts') {
      if (typeof value !== 'boolean') unresolved = true;
      continue;
    }
    if (key === 'attachmentPaths') {
      if (!isUnknownArray(value)
        || value.length !== 0 && !hasBoundedSessionPdfAttachment(input)) unresolved = true;
      continue;
    }
    // `from`, `replyTo`, normalized aliases and future connector fields may
    // alter the effective sender/audience. They never disappear into the
    // generic content allowlist for this exact mutating Gmail tool.
    unresolved = true;
  }

  return uniqueTargets([
    ...targets,
    unresolved ? ADDITIONAL_UNRESOLVED_TARGETS : undefined,
  ]);
}

export function extractInputTargets(
  input: Record<string, unknown>,
  options: { strictExternalSend?: boolean; canonicalGmailSend?: boolean } = {},
): string[] {
  if (options.canonicalGmailSend) return extractCanonicalGmailSendTargets(input);

  const targets: string[] = [];
  let unresolved = false;
  let visitedNodes = 0;

  const appendStringTarget = (candidate: string): void => {
    targets.push(hasDynamicOrGlobTargetSyntax(candidate)
      ? UNRESOLVED_EXTERNAL_TARGET
      : candidate);
  };

  const visit = (value: unknown, depth: number): void => {
    visitedNodes += 1;
    if (depth > 8 || visitedNodes > 1_024) {
      unresolved = true;
      return;
    }
    if (targets.length > 64 || !value || typeof value !== 'object') return;
    if (isUnknownArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    for (const [rawKey, entry] of Object.entries<unknown>((value as Record<string, unknown>))) {
      // Agent-facing presentation metadata is not connector payload. Ignore
      // only the exact root keys stripped before execution and operation
      // hashing; unprefixed or nested lookalikes remain fail-closed.
      if (depth === 0 && (rawKey === '_intent' || rawKey === '_displayName')) continue;
      const key = rawKey
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (options.strictExternalSend && isKnownHttpExternalSendNonAudienceField(key)) {
        // Scalar presentation/content fields are not audiences. Structured
        // values are not opaque, however: providers commonly allow recipient,
        // bcc, URL or routing overrides inside metadata/template/attachment
        // objects. Inspect them recursively and keep unknown shapes unresolved.
        if (entry && typeof entry === 'object') visit(entry, depth + 1);
        continue;
      }
      const resemblesRoutingTarget = /^(?:audiences?|beneficiar(?:y|ies)|channels?|chats?|conversations?|counterpart(?:y|ies)|customers?|destinations?|distribution|groups?|invitees?|mailing_lists?|payees?|recipients?|rooms?|signatories|subscribers?|threads?|users?)(?:_(?:emails?|globs?|ids?|keys?|lists?|selectors?|urls?))$/.test(key);
      if (TARGET_FIELD_NAMES.has(key) || key === 'id' || key.endsWith('_id') || key.endsWith('_ids')
        || resemblesRoutingTarget || options.strictExternalSend
          && (isHttpExternalAudienceField(key) || resemblesUnknownExternalAudienceField(key))) {
        const acceptsNumericTarget = (candidate: unknown): candidate is number =>
          typeof candidate === 'number' && Number.isFinite(candidate)
          && (key === 'amount' || Number.isInteger(candidate));
        let recognized = false;
        if (typeof entry === 'string') appendStringTarget(entry);
        if (typeof entry === 'string') recognized = true;
        if (acceptsNumericTarget(entry)) {
          targets.push(String(entry));
          recognized = true;
        }
        if (isUnknownArray(entry)) {
          recognized = true;
          for (const item of entry) {
            if (typeof item === 'string') appendStringTarget(item);
            if (acceptsNumericTarget(item)) {
              targets.push(String(item));
            }
            if (item && typeof item === 'object') {
              const before = targets.length;
              visit(item, depth + 1);
              if (targets.length === before) unresolved = true;
            } else if (typeof item !== 'string'
              && !acceptsNumericTarget(item)) {
              unresolved = true;
            }
          }
        }
        if (!isUnknownArray(entry) && entry && typeof entry === 'object') {
          recognized = true;
          const before = targets.length;
          visit(entry, depth + 1);
          if (targets.length === before) unresolved = true;
        }
        if (!recognized && entry !== undefined && entry !== null) unresolved = true;
        continue;
      }
      if (options.strictExternalSend && entry !== undefined && entry !== null) {
        // An external-send connector may encode an additional destination in
        // a provider-specific primitive (`routing_address`, `delivery_route`,
        // etc.). Only the closed content/metadata allowlist above may be
        // ignored; every other unknown field keeps the call unresolved.
        unresolved = true;
        continue;
      }
      visit(entry, depth + 1);
    }
  };

  visit(input, 0);
  return uniqueTargets([...targets, unresolved ? ADDITIONAL_UNRESOLVED_TARGETS : undefined]);
}
