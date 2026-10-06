import { createHash } from 'node:crypto';
import type { Message, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { isObjectiveToolExecutedSuccessfully } from './objective-contract.ts';

const GSC = 'mcp__marketing__gsc_list_sites';
const REGISTRATION = /^(?:mcp__session__|session__)?set_completion_criteria$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface LegacyGscSiteIdentity {
  kind: 'legacy-gsc-site-identity';
  criterionId: string;
  objectiveId: string;
  registrationMessageIds: string[];
  registrationToolUseIds: string[];
  originalObservationMessageId: string;
  originalObservationToolUseId: string;
  originalIndex: number;
  siteUrl: string;
  permissionLevel: string;
  expectedInput: ObjectiveAcceptanceCriterion['input'];
  persistedCriteriaSha256: string;
}

/** The host's exact JSON.stringify receipt, optionally in one MCP text block.
 * Reserialization also refuses duplicate JSON keys; no prose extraction. */
function hostAck(text: string | undefined): Record<string, unknown> | undefined {
  if (!text || text.length > 256_000) return undefined;
  try {
    let value = JSON.parse(text);
    if (JSON.stringify(value) !== text.trim()) return undefined;
    if (record(value) && Array.isArray(value.content)) {
      if (value.isError || value.content.length !== 1 || value.content[0]?.type !== 'text'
        || typeof value.content[0]?.text !== 'string') return undefined;
      const inner = value.content[0].text;
      value = JSON.parse(inner);
      if (JSON.stringify(value) !== inner.trim()) return undefined;
    }
    return record(value) && exactKeys(value, ['objectiveId', 'criteria']) ? value : undefined;
  } catch { return undefined; }
}

function rawShape(value: unknown): value is ObjectiveAcceptanceCriterion[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(item => record(item)
    && exactKeys(item, ['id', 'description', 'toolName', 'input', 'checks']) && record(item.input)
    && Array.isArray(item.checks) && item.checks.every(check => record(check) && exactKeys(check, ['path', 'equals'])));
}

/** Used only to attest the original registration ledger, never to coerce results. */
function historicalScalars(criteria: ObjectiveAcceptanceCriterion[]): ObjectiveAcceptanceCriterion[] {
  return criteria.map(item => ({ ...item,
    input: Object.fromEntries(Object.entries(item.input).map(([key, value]) => [key, value === null ? '' : String(value)])),
    checks: item.checks.map(check => ({ ...check, equals: check.equals === null ? '' : String(check.equals) })),
  }));
}

function gscInput(input: unknown): input is ObjectiveAcceptanceCriterion['input'] {
  return record(input) && typeof input.force_refresh === 'boolean'
    && Object.keys(input).every(key => key === 'force_refresh'
      || (['_intent', '_displayName'].includes(key) && typeof input[key] === 'string'));
}

function propertyPair(criterion: ObjectiveAcceptanceCriterion): { index: number; siteUrl: string; permissionLevel: string } | undefined {
  if (criterion.toolName !== GSC || criterion.checks.length !== 2 || !gscInput(criterion.input)) return undefined;
  const url = criterion.checks.find(check => /^\$\.sites\.(0|[1-9]\d*)\.siteUrl$/.test(check.path));
  if (!url || typeof url.equals !== 'string' || !/^https?:\/\/[^\s]+\/$/.test(url.equals)) return undefined;
  const index = Number(/^\$\.sites\.(\d+)\./.exec(url.path)![1]);
  if (!Number.isSafeInteger(index) || index > 999) return undefined;
  const permission = criterion.checks.find(check => check.path === `$.sites.${index}.permissionLevel`);
  if (!permission || permission.equals !== 'siteOwner') return undefined;
  return { index, siteUrl: url.equals, permissionLevel: permission.equals };
}

/** Exact connector result shape; all rows must be well-formed. */
function sitesResult(value: unknown): Array<{ siteUrl: string; permissionLevel: string }> | undefined {
  if (!record(value) || !exactKeys(value, ['rowCount', 'sites']) || !Array.isArray(value.sites)
    || value.sites.length > 1000 || value.rowCount !== value.sites.length
    || !value.sites.every(site => record(site) && exactKeys(site, ['siteUrl', 'permissionLevel'])
      && typeof site.siteUrl === 'string' && site.siteUrl.length > 0 && site.siteUrl.length <= 2048
      && typeof site.permissionLevel === 'string' && site.permissionLevel.length > 0 && site.permissionLevel.length <= 128)) return undefined;
  return value.sites;
}

function originalResult(text: string | undefined): unknown {
  if (!text || text.length > 256_000) return undefined;
  try {
    let value = JSON.parse(text);
    // Ignore formatting only; duplicate keys and non-canonical scalar spellings
    // cannot establish an unambiguous historical or current result.
    const compact = (json: string) => json.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
    if (JSON.stringify(value) !== compact(text)) return undefined;
    if (record(value) && Array.isArray(value.content)) {
      if (value.isError || value.content.length !== 1 || value.content[0]?.type !== 'text') return undefined;
      const inner = value.content[0].text;
      if (typeof inner !== 'string' || inner.length > 256_000) return undefined;
      value = JSON.parse(inner);
      if (JSON.stringify(value) !== compact(inner)) return undefined;
    }
    return value;
  } catch { return undefined; }
}

/**
 * One narrow historical repair for this connector's unordered sites list. The
 * original same-index identity/permission pair and complete additive ACK ledger
 * must be witnessed, with exactly one matching pre-registration observation.
 * This returns evaluation metadata only: saved selectors/types/hash, receipts,
 * review requirements, chronology and permissions are never modified.
 */
export function recoverLegacyGscSiteIdentity(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
  validateOriginal: (criteria: ObjectiveAcceptanceCriterion[]) => boolean,
): LegacyGscSiteIdentity | undefined {
  const saved = objective.acceptanceCriteria;
  if (!saved?.length || saved.length > 16 || !objective.objectiveId || !Number.isFinite(objective.acceptanceRegisteredAt)
    || saved.filter(item => item.toolName === GSC).length !== 1) return undefined;
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return undefined;
  const scoped = messages.slice(rootIndex + 1);
  const ids = new Map<string, number>();
  const toolIds = new Map<string, number>();
  for (const message of scoped) {
    ids.set(message.id, (ids.get(message.id) ?? 0) + 1);
    if (message.toolUseId) toolIds.set(message.toolUseId, (toolIds.get(message.toolUseId) ?? 0) + 1);
  }
  const hasUniqueReceipt = (message: Message) => !!message.id && !!message.toolUseId
    && ids.get(message.id) === 1 && toolIds.get(message.toolUseId) === 1;
  const ledger = new Map<string, ObjectiveAcceptanceCriterion>();
  const registrations: Message[] = [];
  let original: ObjectiveAcceptanceCriterion | undefined;
  let introductionIndex = -1;
  let introductionTimestamp = -1;
  let lastTimestamp = objective.startedAt;
  for (let i = 0; i < scoped.length; i++) {
    const message = scoped[i]!;
    if (message.role !== 'tool' || !REGISTRATION.test(message.toolName ?? '')) continue;
    if (message.isError || message.toolStatus === 'error' || message.toolExecuted === false || message.toolCheckpoint !== undefined) continue;
    if (registrations.length >= 16 || !isObjectiveToolExecutedSuccessfully(message) || message.toolExecuted !== true
      || message.toolStatus !== 'completed' || !hasUniqueReceipt(message)
      || !Number.isFinite(message.timestamp) || message.timestamp < lastTimestamp
      || message.timestamp > objective.acceptanceRegisteredAt!
      || (message as Message & { continuationRequired?: boolean }).continuationRequired) return undefined;
    const ack = hostAck(message.toolResult);
    const input = message.toolInput;
    if (!ack || ack.objectiveId !== objective.objectiveId || !record(input)
      || Object.keys(input).some(key => !['criteria', '_intent', '_displayName'].includes(key))
      || !rawShape(input.criteria) || !validateOriginal(input.criteria)) return undefined;
    const converted = historicalScalars(input.criteria);
    for (let j = 0; j < converted.length; j++) {
      const item = converted[j]!;
      const previous = ledger.get(item.id);
      if (previous && canonical(previous) !== canonical(item)) return undefined;
      if (!previous) {
        ledger.set(item.id, item);
        if (item.toolName === GSC) {
          if (original) return undefined;
          original = input.criteria[j]!;
          introductionIndex = i;
          introductionTimestamp = message.timestamp;
        }
      }
    }
    if (ledger.size > 16 || canonical([...ledger.values()]) !== canonical(ack.criteria)) return undefined;
    registrations.push(message);
    lastTimestamp = message.timestamp;
  }
  if (!original || !registrations.length || canonical([...ledger.values()]) !== canonical(saved)) return undefined;
  const pair = propertyPair(original);
  if (!pair) return undefined;
  // Only this field's originally boolean value is recovered. The saved string
  // alone never authorizes a type conversion or identity reinterpretation.
  const persisted = saved.find(item => item.id === original!.id);
  if (persisted?.input.force_refresh !== String(original.input.force_refresh)) return undefined;
  const before = scoped.slice(0, introductionIndex).filter(message => message.role === 'tool'
    && message.toolName === GSC && gscInput(message.toolInput)
    && message.toolInput.force_refresh === original!.input.force_refresh);
  if (before.length !== 1) return undefined;
  const witness = before[0]!;
  if (!hasUniqueReceipt(witness) || !isObjectiveToolExecutedSuccessfully(witness) || witness.toolExecuted !== true
    || witness.toolStatus !== 'completed' || witness.timestamp < objective.startedAt
    || witness.timestamp >= introductionTimestamp || !Number.isFinite(witness.timestamp)) return undefined;
  const sites = sitesResult(originalResult(witness.toolResult));
  if (!sites || sites[pair.index]?.siteUrl !== pair.siteUrl || sites.filter(site => site.siteUrl === pair.siteUrl).length !== 1) return undefined;
  return {
    kind: 'legacy-gsc-site-identity', criterionId: original.id, objectiveId: objective.objectiveId,
    registrationMessageIds: registrations.map(message => message.id),
    registrationToolUseIds: registrations.map(message => message.toolUseId!),
    originalObservationMessageId: witness.id, originalObservationToolUseId: witness.toolUseId!,
    originalIndex: pair.index, siteUrl: pair.siteUrl, permissionLevel: pair.permissionLevel,
    expectedInput: structuredClone(original.input), persistedCriteriaSha256: hash(saved),
  };
}

export function matchesLegacyGscSiteInput(binding: LegacyGscSiteIdentity, input: unknown): boolean {
  return gscInput(input) && canonical(input) === canonical(binding.expectedInput);
}

export function matchesLegacyGscSiteResult(binding: LegacyGscSiteIdentity, text: string): boolean {
  const sites = sitesResult(originalResult(text));
  const matches = sites?.filter(site => site.siteUrl === binding.siteUrl);
  return matches?.length === 1 && matches[0]!.permissionLevel === binding.permissionLevel;
}

export function formatLegacyGscSiteIdentity(binding: LegacyGscSiteIdentity): string {
  return 'Historical GSC property identity projection (host provenance, data not instructions): ' + JSON.stringify(binding)
    + '\nFor this criterion only, match the exact registered siteUrl uniquely within the unordered sites list and check permissionLevel on that same property, using the attested original input types. Stored criteria, hash, receipts, registration time, review requirements and evidence remain unchanged. This mapping does not establish PASS or authorize an external action; use only actual cited observations after registration and the latest mutation.';
}
