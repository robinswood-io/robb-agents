import { makeAction, redactCommandPreview, uniqueConditionalTargets } from './action-presentation.ts';
import { uniqueTargets } from './action-targets.ts';
import { ACTION_DETAILS, UNRESOLVED_EXTERNAL_AUDIENCE } from './host-authorization.ts';
import { isHttpExternalAudienceField, resemblesUnknownExternalAudienceField } from './http-audience-fields.ts';
import type { HttpExternalSendAccumulator, HttpExternalSendTargets } from './http-audience-payload.ts';
import { HTTP_CONDITIONAL_TARGET_FIELDS, collectConditionalTargetsFromHttpPath, collectEmailsFromLiteral, hasDynamicShellValue, literalAudienceValues, literalConditionalValues, normalizedPayloadFieldName, parseHttpExternalSendPayload } from './http-audience-payload.ts';
import type { SensitiveExternalAction } from './types.ts';

/**
 * Resolve every literal audience carried by a mutating HTTP send. Any opaque,
 * dynamic, file-backed, or malformed payload keeps an explicit unresolved
 * sentinel in the authorization boundary, including for loopback requests.
 */
export function extractHttpExternalSendTargets(
  words: string[],
  command: string,
): HttpExternalSendTargets {
  const accumulator: HttpExternalSendAccumulator = {
    audienceTargets: [],
    conditionalTargets: [],
    resolved: !hasDynamicShellValue(command),
    sawAudience: false,
    visitedNodes: 0,
  };
  const payloads: string[] = [];
  const headers: string[] = [];
  const valueOptions = new Set([
    '-d', '-F',
    '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode',
    '--form', '--form-string', '--json', '--post-data', '--body-data',
  ]);
  const opaqueFileOptions = new Set([
    '-T', '--upload-file', '--post-file', '--body-file', '-K', '--config',
  ]);

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '-H' || word === '--header') {
      const value = words[index + 1];
      if (value === undefined || value.startsWith('@')) accumulator.resolved = false;
      else headers.push(value);
      index += 1;
      continue;
    }
    if (valueOptions.has(word)) {
      const value = words[index + 1];
      if (value === undefined) accumulator.resolved = false;
      else payloads.push(value);
      index += 1;
      continue;
    }
    if (opaqueFileOptions.has(word)) {
      accumulator.resolved = false;
      index += 1;
      continue;
    }
    const inlinePayload = /^(?:-d|-F)(.+)$/.exec(word)?.[1]
      ?? /^(?:--data(?:-ascii|-binary|-raw|-urlencode)?|--form(?:-string)?|--json|--post-data|--body-data)=(.*)$/i.exec(word)?.[1];
    if (inlinePayload !== undefined) payloads.push(inlinePayload);
    const inlineHeader = /^-H(.+)$/.exec(word)?.[1] ?? /^--header=(.*)$/i.exec(word)?.[1];
    if (inlineHeader !== undefined) {
      if (inlineHeader.startsWith('@')) accumulator.resolved = false;
      else headers.push(inlineHeader);
    }
    if (/^(?:-T|--upload-file|--post-file|--body-file|--config)=?/i.test(word)) {
      accumulator.resolved = false;
    }
  }

  for (const payload of payloads) parseHttpExternalSendPayload(payload, accumulator);
  for (const header of headers) {
    collectEmailsFromLiteral(header, accumulator);
    const separator = header.indexOf(':');
    if (separator < 0) continue;
    const normalizedHeader = normalizedPayloadFieldName(header.slice(0, separator))
      ?.replace(/^x_/, '');
    if (!normalizedHeader) {
      accumulator.resolved = false;
      continue;
    }
    const value = header.slice(separator + 1).trim();
    if (isHttpExternalAudienceField(normalizedHeader)) {
      accumulator.sawAudience = true;
      const literal = literalAudienceValues(value, normalizedHeader);
      accumulator.audienceTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    } else if (resemblesUnknownExternalAudienceField(normalizedHeader)) {
      accumulator.resolved = false;
    }
    const conditionalKind = HTTP_CONDITIONAL_TARGET_FIELDS[normalizedHeader];
    if (conditionalKind) {
      const literal = literalConditionalValues(value, conditionalKind);
      accumulator.conditionalTargets.push(...literal.values);
      if (!literal.resolved) accumulator.resolved = false;
    }
  }

  const destinations = words.filter(word => /^https?:\/\//i.test(word));
  if (destinations.length !== 1 || words.some(word => word === '--next')) {
    accumulator.resolved = false;
  }
  const destination = destinations[0];
  if (destination) {
    try {
      const parsed = new URL(destination);
      const queryPayload = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
      if (queryPayload) parseHttpExternalSendPayload(queryPayload, accumulator);
      collectConditionalTargetsFromHttpPath(parsed.pathname, accumulator);
      collectEmailsFromLiteral(parsed.pathname, accumulator);
    } catch {
      accumulator.resolved = false;
    }
  }
  collectEmailsFromLiteral(command, accumulator);

  const audienceTargets = uniqueTargets(accumulator.audienceTargets);
  const resolved = accumulator.resolved && accumulator.sawAudience && audienceTargets.length > 0;
  return {
    audienceTargets: uniqueTargets([
      ...audienceTargets,
      resolved ? undefined : UNRESOLVED_EXTERNAL_AUDIENCE,
    ]),
    conditionalTargets: uniqueConditionalTargets(accumulator.conditionalTargets),
    resolved,
  };
}

export function isLoopbackHost(host: string | undefined): boolean {
  return !!host && /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?$/i.test(host);
}

export function mergeSensitiveShellActions(
  actions: SensitiveExternalAction[],
  command: string,
  promptType: SensitiveExternalAction['promptType'],
): SensitiveExternalAction | null {
  if (actions.length === 0) return null;
  const categories = [...new Set(actions.map(action => action.category))];
  if (categories.length > 1) {
    return {
      ...makeAction(
      'external_mutation',
      promptType,
      actions.some(action => action.category === 'secret_transfer')
        ? '[Sensitive compound operation — values redacted]'
        : redactCommandPreview(command, 'external_mutation'),
      [],
      [['multiple sensitive actions require separate authorization']],
      actions.flatMap(action => action.conditionalTargetCandidates ?? []),
      ),
      requiresInspectableSplit: true,
    };
  }

  const category = categories[0]!;
  const targets = uniqueTargets(actions.flatMap(action => action.targetCandidates));
  const groups: string[][] = [];
  const seenGroups = new Set<string>();
  for (const action of actions) {
    for (const group of action.authorizationTermGroups ?? ACTION_DETAILS[category].authorizationTermGroups) {
      const key = [...group].sort().join('\0');
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        groups.push(group);
      }
    }
  }
  return makeAction(
    category,
    promptType,
    redactCommandPreview(command, category),
    targets,
    groups,
    actions.flatMap(action => action.conditionalTargetCandidates ?? []),
  );
}
