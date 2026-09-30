import { completionCriterionPathKeys as pathKeys } from '@craft-agent/session-tools-core';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration, ObjectiveProcedureId } from '@craft-agent/core/types';
import { createHash } from 'crypto';
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { basename, isAbsolute, resolve, sep } from 'path';
import { BUSINESS_PROCEDURES, businessProcedureCoverage } from './business-procedures.ts';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  extractGmailMessageResultMetadataJson,
  extractLargeResultMetadataJson,
} from '@craft-agent/shared/utils';
import {
  canonicalTerminalReconciliationToolInput,
  contextualGmailExactEffectExpectationFromObjective,
  isObjectiveShellExecutorToolName,
  isObjectiveShellEvidenceCommand,
  isProvablyReadOnlyShellCommand,
  isReadOnlyRegisteredShellObservation,
  normalizeCanonicalBrowserToolName,
  objectiveShellExitZeroProvesSuccess,
} from '@craft-agent/shared/agent';
import { isObjectiveCoordinationTool, isObjectiveToolExecutedSuccessfully, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool } from './objective-contract.ts';
import { recoverLegacyAcceptanceScalars, type ObjectiveAcceptanceCriteriaProjection } from './legacy-acceptance-scalars.ts';
import { recoverLegacyGscSiteIdentity, matchesLegacyGscSiteInput, matchesLegacyGscSiteResult, type LegacyGscSiteIdentity } from './legacy-gsc-site-identity.ts';

/** Own JSON data properties only: getters and prototypes are never consulted. */
function atPath(value: unknown, path: string): unknown {
  const keys = pathKeys(path);
  if (!keys) return undefined;
  for (const key of keys) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

const builtinToolNames = new Map([
  ['bash', 'bash'], ['read', 'read'], ['write', 'write'], ['edit', 'edit'],
  ['find', 'find'], ['glob', 'glob'], ['grep', 'grep'], ['ls', 'ls'],
  ['webfetch', 'web_fetch'], ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'], ['web_search', 'web_search'],
]);

/** Only aliases actually used for native tools; MCP source namespaces stay exact. */
function canonicalToolName(name: string): string {
  const candidate = name.startsWith('functions.') ? name.slice('functions.'.length) : name;
  return builtinToolNames.get(candidate.toLowerCase()) ?? name;
}

const builtinBashEvidenceNames = new Set(['Bash', 'bash', 'functions.bash']);

function referencesToolAlias(evidence: readonly string[], observedToolName: string): boolean {
  return evidence.some(ref => ref.startsWith('tool:')
    && ref.length > 'tool:'.length
    && (ref.slice('tool:'.length) === observedToolName
      || builtinBashEvidenceNames.has(observedToolName)
        && builtinBashEvidenceNames.has(ref.slice('tool:'.length))));
}

// Only use high-confidence partition keys to prove that a mutation is about a
// different target. Generic fields such as `id`, `name`, `key` or `target`
// mean different things across tool schemas and therefore stay conservative.
const TARGET_IDENTITY_KEY_PATTERN = /^(?:account|database|file|file_path|filename|folder|host|job|project|projectId|resource|sessionId|threadId|timer|uri|url|workspace|workspaceId)$/i;
// Only opaque host-generated IDs can prove disjoint targets across two
// different tool schemas. Human-readable host/path/account/resource names can
// alias each other (case, DNS, symlink, redirect, connector-specific meaning).
const DISTINCT_OPAQUE_TARGET_KEY_PATTERN = /^(?:projectId|sessionId|threadId|workspaceId)$/i;

function scalarIdentity(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 2_048) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return undefined;
}

/** Read bounded own-data properties only; tool inputs are untrusted persisted data. */
function inputTargetIdentities(input: Record<string, unknown> | undefined): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let visited = 0;
  while (pending.length && visited++ < 128) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const key of Object.keys(value).slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const identity = scalarIdentity(descriptor.value);
      if (identity !== undefined && TARGET_IDENTITY_KEY_PATTERN.test(key)) {
        const values = targets.get(key.toLowerCase()) ?? new Set<string>();
        values.add(identity);
        targets.set(key.toLowerCase(), values);
      } else if (descriptor.value && typeof descriptor.value === 'object') {
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
  }
  return targets;
}

function criterionTargetIdentities(criterion: ObjectiveAcceptanceCriterion): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const path of Object.keys(criterion.input).slice(0, 16)) {
    const descriptor = Object.getOwnPropertyDescriptor(criterion.input, path);
    if (!descriptor || !('value' in descriptor)) continue;
    const keys = pathKeys(path) ?? [];
    const key = [...keys].reverse().find(candidate => (
      typeof candidate === 'string' && TARGET_IDENTITY_KEY_PATTERN.test(candidate)
    ));
    const identity = scalarIdentity(descriptor.value);
    if (key === undefined || identity === undefined) continue;
    const values = targets.get(key.toLowerCase()) ?? new Set<string>();
    values.add(identity);
    targets.set(key.toLowerCase(), values);
  }
  return targets;
}

/**
 * A mutation invalidates one criterion unless its persisted input proves that
 * it targets a different entity/resource. Unknown or broad mutations remain
 * conservative; an explicit mismatching ID/path avoids re-running unrelated
 * checks across the whole objective.
 */
function exactRegisteredShellObservation(
  message: Message,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): boolean {
  if (!isObjectiveToolExecutedSuccessfully(message) || isObjectiveMutationTool(message)) return false;
  if (!isObjectiveShellExecutorToolName(message.toolName ?? '')) return false;
  const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
    .find((value): value is string => typeof value === 'string');
  // Only commands whose closed grammar proves they are observational may
  // coexist with sibling checks. Opaque validators and SSH scripts remain
  // conservative boundaries even when their invocation was registered.
  if (!command || !isReadOnlyRegisteredShellObservation(command)) return false;
  return criteria.some(candidate => (
    canonicalToolName(message.toolName ?? '') === canonicalToolName(candidate.toolName)
    && criterionInputMatchesToolInput(candidate, message.toolInput)
  ));
}

const GMAIL_SEND_PREFLIGHT_TOOL = 'mcp__google-contacts__gmail_send_preflight';
const GMAIL_SEND_TOOL = 'mcp__google-contacts__gmail_send';
const CANONICAL_GMAIL_SEND_FIELDS = new Set([
  'to', 'cc', 'bcc', 'sendAsEmail', 'subject', 'body', 'isHtml', 'attachmentPaths',
  'requireKnownContacts', 'allowExternal', 'checkContacts', '_displayName', '_intent',
]);
const CANONICAL_GMAIL_PREFLIGHT_FIELDS = new Set([
  'to', 'cc', 'bcc', 'from', 'sendAsEmail', 'subject', 'body', 'isHtml',
  'attachmentPaths', 'requireKnownContacts', 'allowExternal', 'checkContacts',
]);
const REQUIRED_GMAIL_PREFLIGHT_FIELDS = [
  'to', 'cc', 'bcc', 'from', 'sendAsEmail', 'subject', 'body', 'isHtml',
  'requireKnownContacts', 'allowExternal', 'checkContacts',
] as const;

function exactOptionalEmailSet(value: unknown): string[] | undefined {
  return value === undefined || value === null || value === '' ? [] : exactEmailSet(value);
}

function singleMailbox(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const matches = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu);
  return matches?.length === 1 ? matches[0]!.toLowerCase() : undefined;
}

function sameJsonScalar(left: unknown, right: unknown): boolean {
  return left === right && (left === null || typeof left === 'boolean'
    || typeof left === 'string' || typeof left === 'number' && Number.isFinite(left));
}

function canonicalGmailPreflightInput(
  criterion: ObjectiveAcceptanceCriterion,
): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(criterion.input)) {
    const keys = pathKeys(path);
    const field = keys?.[0];
    if (typeof field !== 'string' || !CANONICAL_GMAIL_PREFLIGHT_FIELDS.has(field)
      || Object.hasOwn(input, field)) return undefined;
    if (field === 'attachmentPaths') {
      // Acceptance criteria persist scalar selectors only. Reconstruct the
      // connector array from the one admissible indexed selector instead of
      // smuggling an array through the criterion type/schema.
      if (keys?.length !== 2 || keys[1] !== '0' || typeof value !== 'string') return undefined;
      input[field] = [value];
      continue;
    }
    if (keys?.length !== 1) return undefined;
    input[field] = value;
  }
  return REQUIRED_GMAIL_PREFLIGHT_FIELDS.every(field => Object.hasOwn(input, field))
    ? input
    : undefined;
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function sha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

interface GmailAttachmentEffect {
  name: string;
  sizeBytes: number;
  sha256: string;
}

interface GmailAttachmentContract {
  paths: string[];
  names: string[];
}

function boundedSessionPdfAttachmentName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 600) return undefined;
  const match = /^\{\{SESSION_PATH\}\}\/(?:downloads|long_responses)\/(.+\.pdf)$/iu.exec(value);
  const relativePath = match?.[1];
  if (!relativePath || relativePath.includes('\\')) return undefined;
  const components = relativePath.split('/');
  if (components.some(component => !component || component === '.' || component === '..'
    || /[\u0000-\u001f\u007f]/u.test(component))) {
    return undefined;
  }
  return components.at(-1);
}

function canonicalGmailAttachmentContract(value: unknown): GmailAttachmentContract | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return { paths: [], names: [] };
  if (value.length !== 1) return undefined;
  const name = boundedSessionPdfAttachmentName(value[0]);
  return name ? { paths: [value[0] as string], names: [name] } : undefined;
}

const PERSISTED_MCP_WORKSPACE_ROOTS = new Set(['Users', 'home', 'srv']);
const MCP_PATH_INPUT_KEY = /^(?:(?:file|local|remote)_?)?path$/i;

/**
 * One persistence path rewrites `/root/...` as `./root/...`. Reconcile only
 * that prefix artifact for the workspace roots used by supported hosts. Do
 * not resolve components: dot segments, traversal, alternate separators and
 * empty components remain ineligible for compatibility matching.
 */
function canonicalPersistedMcpWorkspacePath(value: string): string | undefined {
  const withoutPrefix = value.startsWith('/') ? value.slice(1)
    : value.startsWith('./') ? value.slice(2)
      : undefined;
  if (withoutPrefix === undefined || withoutPrefix.includes('\\')) return undefined;
  const components = withoutPrefix.split('/');
  if (components.length < 2 || !PERSISTED_MCP_WORKSPACE_ROOTS.has(components[0]!)) return undefined;
  if (components.some(component => !component || component === '.' || component === '..'
    || /[\u0000-\u001f\u007f]/u.test(component))) return undefined;
  return `/${components.join('/')}`;
}

function criterionInputValueMatches(
  toolName: string,
  selector: string,
  actual: unknown,
  expected: unknown,
): boolean {
  if (actual === expected) return true;
  if (!toolName.startsWith('mcp__') || typeof actual !== 'string' || typeof expected !== 'string') return false;
  const keys = pathKeys(selector);
  const inputKey = keys?.at(-1);
  if (typeof inputKey !== 'string' || !MCP_PATH_INPUT_KEY.test(inputKey)) return false;
  const canonicalActual = canonicalPersistedMcpWorkspacePath(actual);
  return canonicalActual !== undefined && canonicalActual === canonicalPersistedMcpWorkspacePath(expected);
}

function criterionInputMatchesToolInput(
  criterion: ObjectiveAcceptanceCriterion,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  return Object.entries(criterion.input).every(([path, expected]) => {
    return criterionInputValueMatches(criterion.toolName, path, atPath(toolInput, path), expected);
  });
}

function exactGmailAttachmentEffect(value: unknown, expected: GmailAttachmentEffect): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['name', 'sha256', 'sizeBytes'])) {
    return false;
  }
  return atPath(value, '$.name') === expected.name
    && atPath(value, '$.sizeBytes') === expected.sizeBytes
    && atPath(value, '$.sha256') === expected.sha256;
}

function exactGmailAttachmentEffects(value: unknown, expected: readonly GmailAttachmentEffect[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => exactGmailAttachmentEffect(item, expected[index]!));
}

function gmailPreflightAttachmentEffect(
  value: unknown,
  expectedPath: string,
  expectedName: string,
): GmailAttachmentEffect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(['exists', 'input', 'name', 'path', 'sha256', 'sizeBytes'])) return undefined;
  const resolvedPath = atPath(value, '$.path');
  const sizeBytes = atPath(value, '$.sizeBytes');
  const sha256 = atPath(value, '$.sha256');
  if (atPath(value, '$.input') !== expectedPath
    || atPath(value, '$.exists') !== true
    || atPath(value, '$.name') !== expectedName
    || resolvedPath !== expectedPath
    || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0
    || !sha256Hex(sha256)) return undefined;
  return { name: expectedName, sizeBytes, sha256 };
}

/**
 * A successful canonical Gmail send carries the connector's own preflight and
 * exact post-send verification in one target-bound receipt. That transition
 * realizes, rather than stales, an immediately preceding registered preflight
 * for the exact same payload. This is deliberately not a generic
 * "successful mutation preserves checks" rule: a mismatched/partial receipt,
 * another connector, a failed send, or a later different send still
 * invalidates the older observation.
 */
function gmailSendConfirmsPreflightCriterion(
  message: Message,
  criterion: ObjectiveAcceptanceCriterion,
): boolean {
  if (canonicalToolName(criterion.toolName) !== GMAIL_SEND_PREFLIGHT_TOOL
    || canonicalToolName(message.toolName ?? '') !== GMAIL_SEND_TOOL
    || !isObjectiveToolExecutedSuccessfully(message)
    || !criterionChecksTrue(criterion, 'ok')) return false;

  const preflightInput = canonicalGmailPreflightInput(criterion);
  if (!preflightInput) return false;
  const preflightAttachments = canonicalGmailAttachmentContract(
    Object.hasOwn(preflightInput, 'attachmentPaths') ? preflightInput.attachmentPaths : [],
  );
  if (!preflightAttachments) return false;

  const input = message.toolInput ?? {};
  if (Object.keys(input).some(field => !CANONICAL_GMAIL_SEND_FIELDS.has(field))
    || Object.hasOwn(input, 'from') || Object.hasOwn(input, 'replyTo')) return false;
  const sendAttachments = canonicalGmailAttachmentContract(input.attachmentPaths);
  if (!sendAttachments
    || JSON.stringify(sendAttachments.paths) !== JSON.stringify(preflightAttachments.paths)) return false;
  const expectedTo = exactOptionalEmailSet(preflightInput.to);
  const expectedCc = exactOptionalEmailSet(preflightInput.cc);
  const expectedBcc = exactOptionalEmailSet(preflightInput.bcc);
  const actualTo = exactOptionalEmailSet(input.to);
  const actualCc = exactOptionalEmailSet(input.cc);
  const actualBcc = exactOptionalEmailSet(input.bcc);
  if (!expectedTo || !expectedCc || !expectedBcc || !actualTo || !actualCc || !actualBcc
    || expectedTo.length === 0
    || JSON.stringify(actualTo) !== JSON.stringify(expectedTo)
    || JSON.stringify(actualCc) !== JSON.stringify(expectedCc)
    || JSON.stringify(actualBcc) !== JSON.stringify(expectedBcc)) return false;

  const expectedSender = exactEmailSet(preflightInput.sendAsEmail);
  // The send receipt exposes the effective mailbox and verified From header,
  // not the optional human-readable label supplied to preflight. Preserve the
  // criterion only when that label contains exactly the same single mailbox;
  // do not claim that the display text itself was observed after the send.
  const expectedFrom = singleMailbox(preflightInput.from);
  const actualSender = exactEmailSet(input.sendAsEmail);
  if (!expectedSender || expectedSender.length !== 1 || !actualSender
    || JSON.stringify(actualSender) !== JSON.stringify(expectedSender)
    || expectedFrom !== expectedSender[0]) return false;

  for (const field of [
    'subject', 'body', 'isHtml', 'requireKnownContacts', 'allowExternal', 'checkContacts',
  ]) {
    if (!sameJsonScalar(input[field], preflightInput[field])) return false;
  }
  if (typeof preflightInput.subject !== 'string' || typeof preflightInput.body !== 'string'
    || typeof preflightInput.isHtml !== 'boolean'
    || typeof preflightInput.requireKnownContacts !== 'boolean'
    || typeof preflightInput.allowExternal !== 'boolean'
    || typeof preflightInput.checkContacts !== 'boolean') return false;
  const result = resultProjection(message, false);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const messageId = atPath(result, '$.id');
  const verificationMessageId = atPath(result, '$.verification.messageId');
  const operationKey = atPath(result, '$.operationKey');
  const expectedOperationKey = atPath(result, '$.verification.expected.operationKey');
  const bodySha256 = atPath(result, '$.verification.bodySha256');
  const expectedBodySha256 = atPath(result, '$.verification.expected.bodySha256');
  const preflightAttachmentItems = atPath(result, '$.preflight.attachments.items');
  let attachmentEffects: GmailAttachmentEffect[] = [];
  if (preflightAttachments.paths.length === 1) {
    if (!Array.isArray(preflightAttachmentItems) || preflightAttachmentItems.length !== 1
      || !emptyArray(atPath(result, '$.preflight.attachments.duplicateNames'))) return false;
    const effect = gmailPreflightAttachmentEffect(
      preflightAttachmentItems[0],
      preflightAttachments.paths[0]!,
      preflightAttachments.names[0]!,
    );
    if (!effect) return false;
    attachmentEffects = [effect];
  } else if (!emptyArray(preflightAttachmentItems)) return false;
  const totalAttachmentBytes = attachmentEffects.reduce((total, effect) => total + effect.sizeBytes, 0);
  if (typeof messageId !== 'string' || !messageId
    || verificationMessageId !== messageId
    || !sha256Hex(operationKey) || expectedOperationKey !== operationKey
    || !sha256Hex(bodySha256) || expectedBodySha256 !== bodySha256
    || atPath(result, '$.sent') !== true
    || !exactStringArray(atPath(result, '$.labelIds'), ['SENT'])
    || atPath(result, '$.attachment_count') !== preflightAttachments.names.length
    || !exactStringArray(atPath(result, '$.attachment_names'), preflightAttachments.names)
    || atPath(result, '$.preflight.ok') !== true
    || atPath(result, '$.preflight.attachments.count') !== preflightAttachments.names.length
    || atPath(result, '$.preflight.attachments.totalBytes') !== totalAttachmentBytes
    || atPath(result, '$.verification.ok') !== true
    || atPath(result, '$.verification.checks.sentLabelPresent') !== true
    || atPath(result, '$.verification.checks.fromMatches') !== true
    || atPath(result, '$.verification.checks.fromHeaderMatches') !== true
    || atPath(result, '$.verification.checks.replyToMatches') !== true
    || atPath(result, '$.verification.checks.operationHeaderMatches') !== true
    || atPath(result, '$.verification.checks.toMatches') !== true
    || atPath(result, '$.verification.checks.ccMatches') !== true
    || atPath(result, '$.verification.checks.subjectMatches') !== true
    || atPath(result, '$.verification.checks.bodyMatches') !== true
    || atPath(result, '$.verification.checks.attachmentNamesMatch') !== true
    || atPath(result, '$.verification.checks.attachmentEffectsMatch') !== true) return false;

  const resultTo = exactOptionalEmailSet(atPath(result, '$.to'));
  const resultCc = exactOptionalEmailSet(atPath(result, '$.cc'));
  const resultSender = exactEmailSet(atPath(result, '$.requested_send_as_email'));
  if (!resultTo || !resultCc || !resultSender
    || JSON.stringify(resultTo) !== JSON.stringify(expectedTo)
    || JSON.stringify(resultCc) !== JSON.stringify(expectedCc)
    || JSON.stringify(resultSender) !== JSON.stringify(expectedSender)
    || singleMailbox(atPath(result, '$.requested_from')) !== expectedSender[0]
    || atPath(result, '$.requested_reply_to') !== expectedSender[0]
    || atPath(result, '$.subject') !== preflightInput.subject
    || singleMailbox(atPath(result, '$.preflight.sender.requestedFrom')) !== expectedSender[0]
    || atPath(result, '$.preflight.sender.requestedSendAsEmail') !== expectedSender[0]
    || atPath(result, '$.preflight.sender.resolvedEmail') !== expectedSender[0]
    || JSON.stringify(atPath(result, '$.preflight.recipients.to')) !== JSON.stringify(expectedTo)
    || JSON.stringify(atPath(result, '$.preflight.recipients.cc')) !== JSON.stringify(expectedCc)
    || JSON.stringify(atPath(result, '$.preflight.recipients.bcc')) !== JSON.stringify(expectedBcc)
    || atPath(result, '$.preflight.sender.effectiveEmail') !== expectedSender[0]
    || atPath(result, '$.preflight.sender.replyTo') !== expectedSender[0]
    || atPath(result, '$.preflight.sender.identityFound') !== true
    || atPath(result, '$.preflight.sender.verified') !== true
    || atPath(result, '$.preflight.subject') !== preflightInput.subject
    || atPath(result, '$.preflight.body.isHtml') !== preflightInput.isHtml
    || atPath(result, '$.preflight.body.plainLength') !== [...preflightInput.body].length
    || !exactStringArray(atPath(result, '$.verification.expected.from'), expectedSender)
    || singleMailbox(atPath(result, '$.verification.expected.fromHeader')) !== expectedSender[0]
    || !exactStringArray(atPath(result, '$.verification.expected.replyTo'), expectedSender)
    || !exactStringArray(atPath(result, '$.verification.expected.to'), expectedTo)
    || !exactStringArray(atPath(result, '$.verification.expected.cc'), expectedCc)
    || atPath(result, '$.verification.expected.subject') !== preflightInput.subject
    || !exactStringArray(atPath(result, '$.verification.expected.attachmentNames'), preflightAttachments.names)
    || !exactGmailAttachmentEffects(atPath(result, '$.verification.expected.attachmentEffects'), attachmentEffects)
    || !exactStringArray(atPath(result, '$.verification.attachmentNames'), preflightAttachments.names)
    || !exactGmailAttachmentEffects(atPath(result, '$.verification.attachmentEffects'), attachmentEffects)) return false;

  const embeddedPreflight = atPath(result, '$.preflight');
  return criterion.checks.every(check => check.path === '$text'
    ? false
    : atPath(embeddedPreflight, check.path) === check.equals);
}

function mutationMayAffectCriterion(
  message: Message,
  criterion: ObjectiveAcceptanceCriterion,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): boolean {
  if (!isObjectiveEvidenceInvalidatingMutation(message)) return false;
  if (gmailSendConfirmsPreflightCriterion(message, criterion)) return false;
  // Exact registered shell observations do not stale their sibling checks.
  // This exemption is available only after the immutable invocation matches;
  // arbitrary or detected-mutating shell commands remain fail-closed.
  if (exactRegisteredShellObservation(message, criteria)) return false;
  // A registered observation command may be more expressive than the generic
  // Safe-mode shell allow-list (for example a dedicated validation script).
  // Do not let that exact successful invocation invalidate itself; all later
  // unknown/mutating commands remain conservative.
  if (!isObjectiveMutationTool(message)
    && isObjectiveToolExecutedSuccessfully(message)
    && canonicalToolName(message.toolName ?? '') === canonicalToolName(criterion.toolName)
    && criterionInputMatchesToolInput(criterion, message.toolInput)) {
    return false;
  }
  const expected = criterionTargetIdentities(criterion);
  const actual = inputTargetIdentities(message.toolInput);
  const sharedKeys = [...expected.keys()].filter(key => actual.has(key));
  if (sharedKeys.length > 0) {
    // A matching opaque identity is authoritative even if another, broader
    // partition field is inconsistent. Only wholly disjoint opaque identities
    // prove a different entity. Human-readable hosts, paths, URLs and resources
    // can alias each other and therefore remain conservative.
    const opaqueKeys = sharedKeys.filter(key => DISTINCT_OPAQUE_TARGET_KEY_PATTERN.test(key));
    const matchingOpaqueIdentity = opaqueKeys.some(key => (
      [...expected.get(key)!].some(value => actual.get(key)!.has(value))
    ));
    if (matchingOpaqueIdentity) return true;
    if (opaqueKeys.length > 0) return false;
  }
  return true;
}

interface ObservationBoundary {
  afterMessageIndex: number;
  timestamp: number;
  strictTimestamp?: boolean;
}

function observationBoundary(
  objective: ActiveSessionObjective,
  binding: LegacyGscSiteIdentity | undefined,
  messages: readonly Message[],
  rootIndex: number,
): ObservationBoundary {
  // Modern criteria are immutable exact target/result predicates. Reuse an
  // already successful observation from this objective instead of asking the
  // model to repeat it merely because registration happened later. The narrow
  // legacy identity repair keeps its attested historical boundary.
  if (binding) return { afterMessageIndex: rootIndex, timestamp: objective.acceptanceRegisteredAt ?? objective.startedAt };
  // A direct user amendment creates a new semantic target. Reuse observations
  // made after that authenticated amendment (even before registration), never
  // evidence from the superseded revision. Older persisted revisions without
  // the amendment journal keep the conservative registration boundary.
  if (objective.acceptanceRevision && objective.acceptanceRevision !== objective.userMessageId) {
    const revisionIndexes = messages.flatMap((message, index) => message.role === 'user'
      && message.id === objective.acceptanceRevision && !message.hidden && !message.internalOrigin
      && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []);
    if (revisionIndexes.length === 1 && revisionIndexes[0]! > rootIndex) {
      return { afterMessageIndex: revisionIndexes[0]!, timestamp: objective.startedAt };
    }
    return { afterMessageIndex: rootIndex, timestamp: objective.acceptanceRegisteredAt ?? objective.startedAt,
      strictTimestamp: true };
  }
  return { afterMessageIndex: rootIndex, timestamp: objective.startedAt };
}

function observationIsAfterBoundary(message: Message, messageIndex: number, boundary: ObservationBoundary): boolean {
  return messageIndex > boundary.afterMessageIndex
    && (boundary.strictTimestamp ? message.timestamp > boundary.timestamp : message.timestamp >= boundary.timestamp);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 2048);
}

function isCriterionInputScalar(toolName: string, path: string, value: unknown): boolean {
  if (isScalar(value)) return true;
  const keys = pathKeys(path);
  // Exact Gmail bodies use the same 4,000-character ceiling as the
  // authenticated objective parser. Keep the larger allowance confined to
  // this verifier field instead of broadening every persisted criterion.
  return canonicalToolName(toolName) === 'mcp__google-contacts__gmail_verify_sent_message'
    && keys?.length === 1 && keys[0] === 'expectedBody'
    && typeof value === 'string' && value.length <= 4000;
}

function selectorIdentity(path: string): string {
  return path === '$text' ? '$text' : JSON.stringify(pathKeys(path));
}

/** Syntax/order changes must retain the exact target and every expected value. */
function criterionIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  const ordered = (entries: Array<[string, unknown]>) => entries
    .map(([path, value]) => [selectorIdentity(path), value])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return JSON.stringify({
    id: criterion.id, supersedes: criterion.supersedes, requirementId: criterion.requirementId,
    description: criterion.description, toolName: canonicalToolName(criterion.toolName),
    input: ordered(Object.entries(criterion.input)),
    checks: ordered(criterion.checks.map(check => [check.path, check.equals])),
  });
}

/** A model-authored successor may version an existing check, never rewrite its
 * meaning after observing the result. Human amendments use the separate full
 * acceptance-revision path. */
function criterionSupersessionIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  return criterionIdentity({
    ...criterion,
    id: 'versioned-criterion',
    supersedes: undefined,
  });
}

const TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR = 'Terminal reconciliation freezes the registered acceptance contract; set_completion_criteria may only repeat the complete existing criteria and procedure exactly';
const TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR = 'Terminal reconciliation may register only checks already satisfied by exact persisted read-only observations from this objective before the reconciliation marker';

/** A receipt-only terminal reconciliation may observe evidence, never rewrite its reviewed contract. */
function assertTerminalReconciliationAcceptanceContract(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  procedureId?: ObjectiveProcedureId,
): void {
  if (!objective.terminalReconciliation) return;
  if (procedureId !== undefined && procedureId !== objective.procedure?.id) {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
  const registered = objective.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria) || criteria.length !== registered.length) {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
  try {
    const incoming = new Map<string, ObjectiveAcceptanceCriterion>();
    for (const criterion of criteria) {
      if (!criterion || typeof criterion.id !== 'string' || incoming.has(criterion.id)) {
        throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
      }
      incoming.set(criterion.id, criterion);
    }
    if (incoming.size !== registered.length || registered.some((criterion) => {
      const repeated = incoming.get(criterion.id);
      return !repeated || criterionIdentity(repeated) !== criterionIdentity(criterion);
    })) throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  } catch {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
}

function resultJson(text: string): unknown {
  try {
    const value = JSON.parse(text);
    // MCP envelopes are transport, not the business result. Unwrap only one
    // unambiguous text block; never extract arbitrary JSON from prose.
    if (Array.isArray(value?.content) && value.content.length === 1
      && value.content[0]?.type === 'text') return JSON.parse(value.content[0].text);
    return value;
  } catch { return undefined; }
}

function browserCommandVerb(input: Record<string, unknown> | undefined): string | undefined {
  const command = input?.command;
  const source = typeof command === 'string'
    ? command
    : Array.isArray(command) && typeof command[0] === 'string' ? command[0] : undefined;
  return source?.trim().split(/\s+/, 1)[0]?.toLowerCase();
}

const MAX_ACCEPTANCE_SPILL_BYTES = 2_000_000;
const MAX_ACCEPTANCE_MEDIA_JSON_BYTES = 8_000_000;

function safeWebFetchRedirect(requestedRaw: string, finalRaw: string): boolean {
  try {
    const requested = new URL(requestedRaw);
    const final = new URL(finalRaw);
    const protocolMatches = requested.protocol === final.protocol
      || requested.protocol === 'http:' && final.protocol === 'https:';
    // A single optional trailing slash is the only path normalization allowed.
    // Repeated slashes may select a different server route and must stay exact.
    const samePath = requested.pathname === final.pathname || (() => {
      if (requested.pathname === '/' || final.pathname === '/') return false;
      const requestedHasSlash = requested.pathname.endsWith('/');
      const finalHasSlash = final.pathname.endsWith('/');
      if (requestedHasSlash === finalHasSlash) return false;
      const withSlash = requestedHasSlash ? requested.pathname : final.pathname;
      const withoutSlash = requestedHasSlash ? final.pathname : requested.pathname;
      return !withoutSlash.endsWith('/') && withSlash === `${withoutSlash}/`;
    })();
    return protocolMatches
      && requested.hostname.toLowerCase() === final.hostname.toLowerCase()
      && requested.port === final.port
      && requested.username === final.username
      && requested.password === final.password
      && samePath
      && requested.search === final.search;
  } catch { return false; }
}

function authenticatedSessionArtifactText(
  filePath: string,
  digest: string,
  maxBytes: number,
  extension: '.txt' | '.json',
  expectedSessionId: string | undefined,
  notBeforeTimestamp: number,
): string | undefined {
  if (!expectedSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedSessionId)
    || !isAbsolute(filePath) || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  try {
    const declaredPath = resolve(filePath);
    const file = lstatSync(declaredPath);
    // The spill must have been produced during this exact tool invocation. A
    // stale same-session file (or a wrapper printed by a later command) is not
    // host evidence. Allow one second for coarse filesystem timestamp
    // precision while retaining the tool-start boundary.
    if (!file.isFile() || file.isSymbolicLink() || file.size > maxBytes
      || file.mtimeMs + 1_000 < notBeforeTimestamp) return undefined;
    const realPath = realpathSync(declaredPath);
    const parts = realPath.split(sep);
    const sessionsIndex = parts.lastIndexOf('sessions');
    const filename = basename(realPath);
    if (sessionsIndex < 0 || sessionsIndex + 3 !== parts.length - 1
      || parts[sessionsIndex + 1] !== expectedSessionId
      || parts[sessionsIndex + 2] !== 'long_responses'
      || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\\${extension}$`).test(filename)) return undefined;
    const fullText = readFileSync(realPath, 'utf8');
    return Buffer.byteLength(fullText, 'utf8') <= maxBytes
      && createHash('sha256').update(fullText).digest('hex') === digest ? fullText : undefined;
  } catch { return undefined; }
}

/** Validate the exact host spill envelope before reading its bounded payload. */
function authenticatedLargeResponseText(
  message: Message,
  text: string,
  expectedSessionId: string | undefined,
): string | undefined {
  const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
  if (!/^\[(?:Large response \(~\d+ tokens\) summarized|Response too large \(~\d+ tokens\))\]$/.test(lines[0] ?? '')
    || lines[1] !== '') return undefined;
  let index = 2;
  let statedMetadata: string | undefined;
  const metadataPrefix = 'Result metadata JSON: ';
  if (lines[index]?.startsWith(metadataPrefix)) {
    statedMetadata = lines[index]!.slice(metadataPrefix.length);
    index += 1;
    if (lines[index++] !== '') return undefined;
  }
  const digest = /^Full data SHA256: ([a-f0-9]{64})$/.exec(lines[index++] ?? '')?.[1];
  if (!digest || lines[index++] !== '') return undefined;
  const filePath = /^Full data saved to: (.+)$/.exec(lines[index++] ?? '')?.[1];
  if (!filePath || !isAbsolute(filePath)
    || lines[index++] !== '- Use Read/Grep to access specific content') return undefined;

  try {
    const filename = basename(filePath);
    if (lines[index++] !== `- Use transform_data with inputFiles: ["long_responses/${filename}"] for data analysis`
      || lines[index] !== undefined && lines[index] !== '') return undefined;
    const fullText = authenticatedSessionArtifactText(
      filePath, digest, MAX_ACCEPTANCE_SPILL_BYTES, '.txt', expectedSessionId, message.timestamp,
    );
    if (fullText === undefined) return undefined;
    const recomputedMetadata = extractLargeResultMetadataJson(fullText, {
      toolName: message.toolName ?? '', input: message.toolInput,
    });
    if (statedMetadata !== recomputedMetadata) return undefined;
    return fullText;
  } catch { return undefined; }
}

function attachBashTransport(projection: unknown, transport: Record<string, unknown> | undefined): unknown {
  if (!transport) return projection;
  if (projection === undefined) return { transport };
  return projection && typeof projection === 'object' && !Array.isArray(projection)
    ? { ...(projection as Record<string, unknown>), transport }
    : { result: projection, transport };
}

/** The rbw SSH connector reports the remote process status as `code`.
 * Preserve a criterion registered with the conventional `exitCode` spelling
 * only for its executed, target-bound structured response. */
function attachRbwSshExitCode(message: Message, projection: unknown): unknown {
  if (message.toolName !== 'mcp__rbw-servers__ssh_execute'
    || message.toolExecuted !== true || !isObjectiveToolExecutedSuccessfully(message)
    || !projection || typeof projection !== 'object' || Array.isArray(projection)) return projection;
  const result = projection as Record<string, unknown>;
  const input = message.toolInput;
  if (typeof input?.server !== 'string' || typeof input.cwd !== 'string'
    || typeof input.command !== 'string' || result.server !== input.server
    || result.command !== `cd ${input.cwd} && ${input.command}`
    || !Number.isSafeInteger(result.code) || typeof result.success !== 'boolean'
    || typeof result.stderr !== 'string' || typeof result.stdout !== 'string') return projection;
  return { ...result, exitCode: result.code };
}

/**
 * A few first-party observation tools intentionally persist human-readable
 * output. Project only their authenticated, exact wire formats into the small
 * structured fields advertised by their tool semantics. This is deliberately
 * not a general JSON/prose extractor: near-miss text remains non-evidence.
 */
function resultProjection(
  message: Message,
  allowLargeResponse = true,
  expectedSessionId?: string,
): unknown {
  const text = message.toolResult ?? '';
  const rawToolName = message.toolName ?? '';
  const toolName = rawToolName.startsWith('functions.')
    ? rawToolName.slice('functions.'.length)
    : rawToolName;
  const bashTransport = message.toolExecuted === true
    && isObjectiveToolExecutedSuccessfully(message) && canonicalToolName(toolName) === 'bash'
    ? (() => {
      const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
        .find((value): value is string => typeof value === 'string');
      return command && objectiveShellExitZeroProvesSuccess(command)
        ? { success: true, code: 0 }
        : { code: 0 };
    })()
    : undefined;
  if (allowLargeResponse) {
    const fullText = authenticatedLargeResponseText(message, text, expectedSessionId);
    if (fullText !== undefined) {
      return resultProjection({ ...message, toolResult: fullText }, false, expectedSessionId);
    }
  }
  const parsed = resultJson(text);
  if (parsed !== undefined) return attachBashTransport(attachRbwSshExitCode(message, parsed), bashTransport);
  // Synthetic projections require a positively recorded execution. Merely
  // completed legacy/checkpoint records are not enough.
  if (message.toolExecuted !== true || !message.toolName) return undefined;

  if (canonicalToolName(toolName) === 'web_fetch') {
    const match = /^JSON from (https?:\/\/[^\r\n]+):\r?\n\r?\n([\s\S]+)$/.exec(withoutFinalLineTerminator(text));
    if (!match || typeof message.toolInput?.url !== 'string') return undefined;
    try {
      if (!safeWebFetchRedirect(message.toolInput.url, match[1]!)) return undefined;
      return JSON.parse(match[2]!);
    } catch { return undefined; }
  }

  if (toolName === 'mcp__google-contacts__gmail_get_message') {
    const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
    const prefix = 'Result metadata JSON: ';
    if (lines[0] !== '[Structured media assets extracted and saved]' || lines[1] !== ''
      || !lines[2]?.startsWith(prefix) || lines[3] !== '') {
      return undefined;
    }
    try {
      const statedMetadata = lines[2].slice(prefix.length);
      const digest = /^Original JSON SHA256: ([a-f0-9]{64})$/.exec(lines[4] ?? '')?.[1];
      const originalPath = /^Original JSON: (.+)$/.exec(lines[5] ?? '')?.[1];
      if (!digest || !originalPath || !lines[6]?.startsWith('Linked JSON: ')
        || !/^Assets extracted: [1-9]\d{0,5}$/.test(lines[7] ?? '')) return undefined;
      const originalJson = authenticatedSessionArtifactText(
        originalPath, digest, MAX_ACCEPTANCE_MEDIA_JSON_BYTES, '.json', expectedSessionId, message.timestamp,
      );
      if (originalJson === undefined
        || extractGmailMessageResultMetadataJson(originalJson, toolName) !== statedMetadata) return undefined;
      const metadata: unknown = JSON.parse(statedMetadata);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
      const record = metadata as Record<string, unknown>;
      const allowed = new Set(['id', 'threadId', 'subject', 'from', 'to', 'cc', 'bcc', 'date', 'messageIdHeader', 'labelIds']);
      if (!Object.keys(record).length || Object.keys(record).some(key => !allowed.has(key))) return undefined;
      for (const [key, value] of Object.entries(record)) {
        if (key === 'labelIds') {
          if (!Array.isArray(value) || value.length > 32
            || value.some(label => typeof label !== 'string' || label.length > 128)) return undefined;
        } else if (typeof value !== 'string' || value.length > 2_048) return undefined;
      }
      return record;
    } catch { return undefined; }
  }

  if (toolName === 'mcp__google-contacts__gmail_search_exact') {
    const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
    if (/^Aucun message Gmail trouvé pour : « .+ »$/.test(lines[0] ?? '') && lines.length === 1) {
      return { resultCount: 0, success: true };
    }
    if (!/^\*\*Recherche Gmail API : .+\*\*$/.test(lines[0] ?? '')) return undefined;
    const count = /^_(0|[1-9]\d{0,5}) message\(s\) retourné\(s\) ; lire le message exact avant toute action\._$/
      .exec(lines[1] ?? '');
    return count ? { resultCount: Number(count[1]), success: true } : undefined;
  }

  if (normalizeCanonicalBrowserToolName(toolName) === 'browser_tool'
    && browserCommandVerb(message.toolInput) === 'navigate') {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const url = firstLine.startsWith('Navigated to: ') ? firstLine.slice('Navigated to: '.length) : '';
    if (!url || url.length > 8_192) return undefined;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return undefined;
      return { success: true, url: parsedUrl.toString() };
    } catch { return undefined; }
  }

  // This first-party connector throws on any non-zero remote exit status. A
  // completed, explicitly executed call therefore attests healthcheck exit 0;
  // retain stdout as evidence while exposing only that transport contract.
  if (toolName === 'mcp__rbw-agents-oss__oss_healthcheck' && text.trim()) {
    return { success: true, code: 0 };
  }
  // Native Bash reports a non-zero exit as a failed tool result. For a real,
  // completed invocation, transport success is therefore deterministic even
  // when curl or another read returns HTML/text instead of JSON.
  if (canonicalToolName(toolName) === 'bash') return attachBashTransport(undefined, bashTransport);
  return undefined;
}

/** A single final LF/CRLF terminates text output; all other whitespace is data. */
function withoutFinalLineTerminator(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Pi appends pagination advice after a user-requested bounded Read. Compare
 * only the returned file lines when the exact native format, line count and
 * next offset all agree with the recorded invocation. A byte-truncated Read,
 * another tool, or an invented continuation notice is never projected. */
function matchesBoundedReadText(message: Message, expected: string): boolean {
  if (canonicalToolName(message.toolName ?? '') !== 'read'
    || message.toolExecuted !== true || !isObjectiveToolExecutedSuccessfully(message)
    || typeof message.toolInput?.path !== 'string' || !message.toolInput.path
    || typeof message.toolResult !== 'string') return false;
  const { offset, limit } = message.toolInput;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)
    || (offset as number) < 1 || (limit as number) < 1 || (limit as number) > 2_000
    || (offset as number) + (limit as number) > Number.MAX_SAFE_INTEGER) return false;
  const match = /^([\s\S]*)\n\n\[([1-9]\d{0,8}) more lines in file\. Use offset=([1-9]\d{0,8}) to continue\.\]$/
    .exec(message.toolResult);
  if (!match || Number(match[3]) !== (offset as number) + (limit as number)
    || match[1]!.split('\n').length !== limit) return false;
  return withoutFinalLineTerminator(match[1]!) === expected;
}

/** A registered text predicate may observe the stdout field of the trusted
 * SSH connector's successful read-only envelope or the exact bounded Read
 * payload. Preserve the persisted criterion and exact expected value; never
 * treat arbitrary JSON, stderr or an unsuccessful command as evidence. */
function matchesAcceptanceResultCheck(
  message: Message,
  projection: unknown,
  check: { path: string; equals: unknown },
): boolean {
  if (check.path !== '$text') return atPath(projection, check.path) === check.equals;
  if (typeof check.equals !== 'string' || message.toolResult === undefined) return false;
  const expected = withoutFinalLineTerminator(check.equals);
  if (withoutFinalLineTerminator(message.toolResult) === expected) return true;
  if (matchesBoundedReadText(message, expected)) return true;
  if (message.toolName !== 'mcp__rbw-servers__ssh_execute'
    || message.toolExecuted !== true) return false;
  const command = message.toolInput?.command;
  if (typeof command !== 'string' || !isProvablyReadOnlyShellCommand(command)) return false;
  const stdout = atPath(projection, '$.stdout');
  return typeof stdout === 'string'
    && atPath(projection, '$.success') === true
    && atPath(projection, '$.code') === 0
    && atPath(projection, '$.stderr') === ''
    && withoutFinalLineTerminator(stdout) === expected;
}

/** Legacy objectives retain their conservative objective-wide registration boundary. */
function criterionRegisteredAt(objective: ActiveSessionObjective, criterionId: string): number {
  const fallback = objective.acceptanceRegisteredAt ?? objective.startedAt;
  const entry = Object.getOwnPropertyDescriptor(objective.acceptanceRegisteredAtById ?? {}, criterionId);
  const value = entry && 'value' in entry ? entry.value : undefined;
  return typeof value === 'number' && Number.isFinite(value)
    && value >= objective.startedAt && value <= fallback ? value : fallback;
}

/** Shared syntax/immutability validation, also used to inspect historical ACKs. */
function validateAndMergeObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  now = Date.now(),
  procedureId?: ObjectiveProcedureId,
): ActiveSessionObjective {
  if (objective.terminalState !== 'active') throw new Error('No active objective');
  if (procedureId && !Object.hasOwn(BUSINESS_PROCEDURES, procedureId)) throw new Error('Unknown business procedure');
  if (objective.procedure && (objective.procedure.version !== 1 || (procedureId && objective.procedure.id !== procedureId))) {
    throw new Error('The registered business procedure cannot be replaced');
  }
  const procedure = objective.procedure ?? (procedureId ? { id: procedureId, version: 1 as const } : undefined);
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 16) throw new Error('Expected 1–16 criteria');
  if (objective.acceptanceNeedsReview) {
    const incoming = new Set(criteria.map(item => item.id));
    const missing = (objective.acceptanceCriteria ?? []).filter(item => !incoming.has(item.id));
    if (missing.length) throw new Error(`Re-register the full amended contract, including existing criterion IDs: ${missing.map(item => item.id).join(', ')}`);
  }
  const byId = new Map((objective.acceptanceNeedsReview ? [] : objective.acceptanceCriteria ?? []).map(item => [item.id, item]));
  const incomingIds = new Set<string>();
  for (const item of criteria) {
    if (item?.requirementId && !procedure) {
      throw new Error(`requirementId "${item.requirementId}" requires a selected business procedure; select procedure or omit requirementId`);
    }
    if (item?.requirementId && procedure) {
      const allowed = BUSINESS_PROCEDURES[procedure.id].requirements.map(requirement => requirement.id);
      if (!allowed.includes(item.requirementId)) {
        throw new Error(`Unknown requirementId "${item.requirementId}" for business procedure "${procedure.id}". Allowed requirementId values: ${allowed.join(', ')}`);
      }
    }
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id)) {
      throw new Error('Invalid or duplicate criterion id');
    }
    if (item.supersedes !== undefined
      && (typeof item.supersedes !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.supersedes))) {
      throw new Error('Invalid superseded criterion id');
    }
    if (objective.completionCriteria.includes(item.id as never)) {
      throw new Error(`Criterion id "${item.id}" is reserved by the host completion contract; choose a different criterion id`);
    }
    if (incomingIds.has(item.id)) throw new Error('Invalid or duplicate criterion id');
    incomingIds.add(item.id);
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 1000
      || typeof item.toolName !== 'string' || !item.toolName.trim()
      || item.toolName.length > 256 || !item.input || typeof item.input !== 'object' || Array.isArray(item.input)
      || Object.keys(item.input).length < 1
      || Object.keys(item.input).length > 16 || !Array.isArray(item.checks)
      || item.checks.length < 1 || item.checks.length > 16) throw new Error('Incomplete criterion');
    const inputSelectors = new Set<string>();
    for (const [path, value] of Object.entries(item.input)) {
      if (!pathKeys(path)?.length || !isCriterionInputScalar(item.toolName, path, value)
        || inputSelectors.has(selectorIdentity(path))) {
        throw new Error('Invalid JSON selector or scalar');
      }
      inputSelectors.add(selectorIdentity(path));
    }
    const resultSelectors = new Set<string>();
    for (const check of item.checks) {
      if (!check || (check.path !== '$text' && pathKeys(check.path) === undefined)
        || (check.path === '$text' && typeof check.equals !== 'string')
        || !isScalar(check.equals) || resultSelectors.has(selectorIdentity(check.path))) {
        throw new Error('Invalid JSON selector or scalar');
      }
      resultSelectors.add(selectorIdentity(check.path));
    }
    const previous = byId.get(item.id);
    if (previous && criterionIdentity(previous) !== criterionIdentity(item)) throw new Error('Registered criteria cannot be weakened or replaced');
    // Preserve serialized criteria and their review hash on equivalent re-registration.
    if (!previous) byId.set(item.id, structuredClone(item));
  }
  if (byId.size > 16) throw new Error('At most 16 criteria per objective');
  // An equivalent retry changes no contract, review hash or evidence boundary.
  // Returning the same object also lets the host avoid a redundant disk flush.
  if (!objective.acceptanceNeedsReview && byId.size === objective.acceptanceCriteria?.length
    && procedure?.id === objective.procedure?.id && procedure?.version === objective.procedure?.version) return objective;
  const previousIds = new Set((objective.acceptanceCriteria ?? []).map(item => item.id));
  return {
    ...objective,
    ...(procedure ? { procedure } : {}),
    acceptanceCriteria: [...byId.values()],
    acceptanceRegisteredRevision: objective.acceptanceRevision ?? objective.userMessageId,
    ...(objective.acceptanceNeedsReview ? {
      acceptanceNeedsReview: false,
      acceptanceHistory: [...(objective.acceptanceHistory ?? []), {
        revision: objective.acceptanceRegisteredRevision ?? objective.userMessageId,
        criteria: structuredClone(objective.acceptanceCriteria ?? []),
        registeredAt: objective.acceptanceRegisteredAt,
        registeredAtById: Object.fromEntries((objective.acceptanceCriteria ?? []).map(item => [
          item.id, criterionRegisteredAt(objective, item.id),
        ])),
      }],
    } : {}),
    acceptanceRegisteredAt: now,
    // Keep registration timestamps as immutable contract provenance. Evidence
    // evaluation uses the objective boundary plus target-relevant mutations,
    // so registering an exact predicate never forces a duplicate observation.
    acceptanceRegisteredAtById: Object.fromEntries([...byId.keys()].map(id => [
      id, !objective.acceptanceNeedsReview && previousIds.has(id) ? criterionRegisteredAt(objective, id) : now,
    ])),
  };
}

function nextCriterionVersionId(previousId: string): string {
  const versioned = /^(.*)_v([1-9]\d*)$/.exec(previousId);
  if (!versioned) return `${previousId}_v2`;
  const version = Number(versioned[2]);
  return `${versioned[1]}_v${version + 1}`;
}

/**
 * Prepare an explicit, fail-closed rollover of a negatively observed check.
 * The successor may advance only its `_vN` identity: description, requirement,
 * tool, target input and checks remain exact. Human amendments use the separate
 * full-contract revision path when acceptance semantics genuinely change.
 */
function applyExplicitCriterionSupersessions(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
  messages: readonly Message[] | undefined,
  expectedSessionId: string | undefined,
): ActiveSessionObjective {
  const replacements = criteria.filter((criterion) => criterion?.supersedes !== undefined);
  if (!replacements.length) return objective;
  if (objective.acceptanceNeedsReview) {
    throw new Error('A user-amended acceptance contract must be re-registered as one complete revision; criterion supersession is only for a failed check in the unchanged objective');
  }
  if (!messages?.length) {
    throw new Error('A criterion can be superseded only after its exact failed observation is available to the host');
  }
  const registered = new Map((objective.acceptanceCriteria ?? []).map(criterion => [criterion.id, criterion]));
  const incomingIds = new Set(criteria.map(criterion => criterion.id));
  const supersededIds = new Set<string>();
  const observations = new Map(collectObjectiveAcceptanceObservations(
    objective,
    [...messages],
    expectedSessionId,
  ).map(observation => [observation.criterionId, observation]));

  for (const replacement of replacements) {
    const previousId = replacement.supersedes!;
    const previous = registered.get(previousId);
    if (!previous || supersededIds.has(previousId) || incomingIds.has(previousId)) {
      throw new Error(`Criterion ${replacement.id} must supersede exactly one existing criterion that is omitted from the new invocation`);
    }
    if (replacement.id !== nextCriterionVersionId(previousId)) {
      throw new Error(`Criterion ${replacement.id} must use the next explicit version ID ${nextCriterionVersionId(previousId)}`);
    }
    if (replacement.requirementId !== previous.requirementId) {
      throw new Error(`Criterion ${replacement.id} must preserve requirementId from ${previousId}`);
    }
    if (criterionSupersessionIdentity(replacement) !== criterionSupersessionIdentity(previous)) {
      throw new Error(`Criterion ${replacement.id} must preserve the exact description, tool, target input and checks from ${previousId}; only a user amendment may change acceptance semantics`);
    }
    const observation = observations.get(previousId);
    if (!observation || observation.passed) {
      throw new Error(`Criterion ${previousId} can be superseded only after its exact current observation completed with a negative result`);
    }
    if (!Number.isFinite(observation.message.timestamp)
      || observation.message.timestamp <= criterionRegisteredAt(objective, previousId)) {
      throw new Error(`Criterion ${previousId} must be re-observed after that exact version was registered before it can be superseded`);
    }
    supersededIds.add(previousId);
  }

  const activeCriteria = (objective.acceptanceCriteria ?? [])
    .filter(criterion => !supersededIds.has(criterion.id));
  const activeRegistrationTimes = Object.fromEntries(Object.entries(
    objective.acceptanceRegisteredAtById ?? {},
  ).filter(([id]) => !supersededIds.has(id)));
  return {
    ...objective,
    acceptanceCriteria: activeCriteria,
    acceptanceRegisteredAtById: activeRegistrationTimes,
    acceptanceHistory: [...(objective.acceptanceHistory ?? []), {
      revision: `criterion-correction:${[...supersededIds].sort().join(',')}`,
      criteria: structuredClone(objective.acceptanceCriteria ?? []),
      registeredAt: objective.acceptanceRegisteredAt,
      registeredAtById: structuredClone(objective.acceptanceRegisteredAtById ?? {}),
    }],
  };
}

function assertObservedCriterionResultShapes(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
  messages: readonly Message[] | undefined,
  expectedSessionId?: string,
): void {
  if (!messages?.length) return;
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return;
  const scoped = messages.slice(rootIndex + 1);
  for (const criterion of criteria) {
    if (criterion.checks.every(check => check.path === '$text')) continue;
    const observed = scoped.findLast(message => message.role === 'tool' && !!message.toolName
      && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
      && criterionInputMatchesToolInput(criterion, message.toolInput)
      && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
      && message.toolResult !== undefined);
    const projection = observed ? resultProjection(observed, true, expectedSessionId) : undefined;
    if (observed && (projection === undefined
      || criterion.checks.some(check => check.path !== '$text' && atPath(projection, check.path) === undefined))) {
      throw new Error(`Criterion ${criterion.id} uses JSON result selectors, but the exact observed ${criterion.toolName} invocation returned text without a supported structured projection for every requested selector. Use $text for exact whole-output equality, check $.transport.code/$.transport.success for native shell transport, or make the read-only check emit valid JSON. Nothing was registered.`);
    }
  }
}

function criterionShellCommand(criterion: ObjectiveAcceptanceCriterion): string | undefined {
  const commands: string[] = [];
  for (const path of Object.keys(criterion.input)) {
    const keys = pathKeys(path);
    if (keys?.length !== 1 || typeof keys[0] !== 'string'
      || !/^(?:command|cmd|script)$/.test(keys[0])) continue;
    const descriptor = Object.getOwnPropertyDescriptor(criterion.input, path);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
    commands.push(descriptor.value);
  }
  return commands.length === 1 ? commands[0] : undefined;
}

function assertAdmissibleShellCriteria(criteria: readonly ObjectiveAcceptanceCriterion[]): void {
  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    if (command && isObjectiveShellEvidenceCommand(command)) continue;
    throw new Error(`Criterion ${criterion.id} uses a shell-executor command that cannot serve as host-observed acceptance evidence. Use a read-only inspection, a named validate/verify/check/test script, a test/check command, or curl GET/HEAD. Inline interpreter/eval/stdin programs, output-only commands and mutating commands are not accepted. Nothing was registered.`);
  }

  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)
      || !criterion.checks.some(check => {
        const keys = pathKeys(check.path);
        return keys?.length === 1 && (keys[0] === 'stdout' || keys[0] === 'stderr');
      })) continue;
    throw new Error(`Criterion ${criterion.id} binds stdout/stderr, but shell output is not a structured result field. Use $text for exact whole-output equality or $.transport.code for successful execution. Nothing was registered.`);
  }

  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    for (const check of criterion.checks) {
      const keys = pathKeys(check.path);
      if (keys?.[0] !== 'transport') continue;
      const codeIsValid = keys.length === 2 && keys[1] === 'code' && check.equals === 0;
      const successIsValid = keys.length === 2 && keys[1] === 'success' && check.equals === true
        && !!command && objectiveShellExitZeroProvesSuccess(command);
      if (codeIsValid || successIsValid) continue;
      throw new Error(`Criterion ${criterion.id} uses an unsupported shell transport predicate. Use exactly $.transport.code == 0, or $.transport.success == true only for a command whose zero exit proves success (for example curl --fail). Nothing was registered.`);
    }
  }
}

function criterionInvocationIdentity(criterion: ObjectiveAcceptanceCriterion): string {
  const input = Object.entries(criterion.input)
    .map(([path, value]) => [selectorIdentity(path), value] as [string, unknown])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([canonicalToolName(criterion.toolName), input]);
}

const EXACT_GMAIL_SENT_VERIFIER = 'mcp__google-contacts__gmail_verify_sent_message';

function criterionInputField(
  criterion: ObjectiveAcceptanceCriterion,
  field: string,
): unknown {
  for (const [path, value] of Object.entries(criterion.input)) {
    const keys = pathKeys(path);
    if (keys?.length === 1 && keys[0] === field) return value;
  }
  return undefined;
}

function criterionChecksTrue(criterion: ObjectiveAcceptanceCriterion, field: string): boolean {
  return criterion.checks.some(check => {
    const keys = pathKeys(check.path);
    return keys?.length === 1 && keys[0] === field && check.equals === true;
  });
}

function exactEmailSet(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  const residue = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '')
    .replace(/[\s,;]+/gu, '');
  return residue || new Set(emails).size !== emails.length
    ? undefined
    : [...new Set(emails)].sort();
}

function objectiveAuthorizationSegments(objective: ActiveSessionObjective): string[] {
  return [
    ...(objective.originalText ? [objective.originalText] : []),
    ...(objective.amendments ?? []).map(amendment => amendment.text),
  ];
}

function exactGmailCompletionCriterionGap(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): string | undefined {
  const expectation = contextualGmailExactEffectExpectationFromObjective(
    objectiveAuthorizationSegments(objective),
  );
  // This additional contract applies only when the human supplied one exact
  // body. Ordinary Gmail inspection and non-exact correspondence keep the
  // generic acceptance machinery.
  if (!expectation?.expectedBody) return undefined;
  const matching = criteria.some(criterion => {
    if (canonicalToolName(criterion.toolName) !== EXACT_GMAIL_SENT_VERIFIER
      || !criterionChecksTrue(criterion, 'ok')) return false;
    const expectedAnchorMessageId = criterionInputField(criterion, 'expectedAnchorMessageId');
    const expectedTo = criterionInputField(criterion, 'expectedTo');
    const expectedCc = criterionInputField(criterion, 'expectedCc');
    const expectedFrom = criterionInputField(criterion, 'expectedFrom');
    const expectedSubject = criterionInputField(criterion, 'expectedSubject');
    const expectedBody = criterionInputField(criterion, 'expectedBody');
    const expectedIsHtml = criterionInputField(criterion, 'expectedIsHtml');
    if (typeof expectedAnchorMessageId !== 'string'
      || expectation.anchorMessageId !== undefined
        && expectedAnchorMessageId.toLowerCase() !== expectation.anchorMessageId
      || typeof expectedTo !== 'string' || exactEmailSet(expectedTo) === undefined
      || typeof expectedCc !== 'string' || exactEmailSet(expectedCc) === undefined
      || typeof expectedSubject !== 'string' || !expectedSubject
      || expectedBody !== expectation.expectedBody
      || expectedIsHtml !== (expectation.expectedIsHtml ?? false)) return false;
    if (expectation.expectedRecipientEmail !== undefined
      && JSON.stringify(exactEmailSet(expectedTo))
        !== JSON.stringify([expectation.expectedRecipientEmail])) return false;
    if (expectation.expectedCc !== undefined
      && JSON.stringify(exactEmailSet(expectedCc))
        !== JSON.stringify(exactEmailSet(expectation.expectedCc))) return false;
    if (expectation.expectedSenderEmail !== undefined
      && JSON.stringify(exactEmailSet(expectedFrom))
        !== JSON.stringify([expectation.expectedSenderEmail])) return false;
    if (expectation.expectedSubject !== undefined
      && expectedSubject !== expectation.expectedSubject) return false;
    return true;
  });
  return matching ? undefined
    : 'Exact Gmail effect lacks one complete sent-message proof bound to the anchor thread, sender, To, Cc, subject and exact body. Register gmail_verify_sent_message with every specified expected field and $.ok == true; the eventual tool call supplies the candidate messageId, and an older message matching only a subset is neither a duplicate nor completion evidence.';
}

function assertExactGmailCompletionCriteria(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): void {
  const gap = exactGmailCompletionCriterionGap(objective, criteria);
  if (gap) throw new Error(`${gap} Nothing was registered; this rejection does not authorize repeating an already identical external effect.`);
}

function shellCriterionMayAffect(
  executing: ObjectiveAcceptanceCriterion,
  target: ObjectiveAcceptanceCriterion,
): boolean {
  const expected = criterionTargetIdentities(target);
  const actual = criterionTargetIdentities(executing);
  const sharedKeys = [...expected.keys()].filter(key => actual.has(key));
  const opaqueKeys = sharedKeys.filter(key => DISTINCT_OPAQUE_TARGET_KEY_PATTERN.test(key));
  if (opaqueKeys.some(key => [...expected.get(key)!].some(value => actual.get(key)!.has(value)))) return true;
  if (opaqueKeys.length > 0) return false;
  return true;
}

/**
 * Two distinct opaque validators may each mutate the state observed by the
 * other. Their immutable criteria then form a chronology cycle: whichever one
 * runs last invalidates an earlier sibling. Reject only newly introduced
 * cycles and direct the caller toward one consolidated receipt or bounded
 * reads; historical contracts remain readable and retryable.
 */
function assertSatisfiableShellCriteria(
  criteria: readonly ObjectiveAcceptanceCriterion[],
  additionIds: ReadonlySet<string>,
): void {
  const groups = new Map<string, ObjectiveAcceptanceCriterion[]>();
  for (const criterion of criteria) {
    if (!isObjectiveShellExecutorToolName(criterion.toolName)) continue;
    const command = criterionShellCommand(criterion);
    if (!command || isProvablyReadOnlyShellCommand(command)
      || isReadOnlyRegisteredShellObservation(command)) continue;
    const identity = criterionInvocationIdentity(criterion);
    const group = groups.get(identity) ?? [];
    group.push(criterion);
    groups.set(identity, group);
  }
  if (groups.size < 2) return;

  const entries = [...groups.entries()];
  const edges = new Map(entries.map(([identity]) => [identity, new Set<string>()]));
  for (const [sourceIdentity, source] of entries) {
    for (const [targetIdentity, target] of entries) {
      if (sourceIdentity !== targetIdentity && shellCriterionMayAffect(source[0]!, target[0]!)) {
        edges.get(sourceIdentity)!.add(targetIdentity);
      }
    }
  }
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (!visited.add(from)) return false;
    for (const next of edges.get(from) ?? []) {
      if (next === target || reaches(next, target, visited)) return true;
    }
    return false;
  };
  const cyclicAddition = entries.find(([identity, group]) => (
    group.some(criterion => additionIds.has(criterion.id))
    && [...(edges.get(identity) ?? [])].some(next => reaches(next, identity))
  ));
  if (!cyclicAddition) return;
  const ids = cyclicAddition[1].map(criterion => criterion.id).join(', ');
  throw new Error(`Opaque shell acceptance criteria cannot be satisfied across distinct invocations (including: ${ids}) because their observations may invalidate each other. Consolidate them into one read-only invocation that returns all required fields, or use separate bounded reads such as curl GET/HEAD, docker inspect/ps, systemctl is-active, or gh pr view. Nothing was registered.`);
}

/** Reject new contradictory obligations; never rewrite or re-admit old contracts. */
export function registerObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  now = Date.now(),
  procedureId?: ObjectiveProcedureId,
  messages?: readonly Message[],
  expectedSessionId?: string,
): ActiveSessionObjective {
  if (objective.terminalState !== 'active') throw new Error('No active objective');
  // A reconciliation can arrive before an objective that requires checks has
  // registered its first contract. Permit that one normal registration; once
  // any criterion exists, the resulting host binding is immutable.
  if (objective.terminalReconciliation) {
    if (objective.acceptanceCriteria?.length && !objective.acceptanceNeedsReview) {
      assertTerminalReconciliationAcceptanceContract(objective, criteria, procedureId);
      return objective;
    }
    if (objective.terminalReconciliation.initialAcceptanceRegistrationRequired !== true
      || objective.requiresAcceptanceCriteria !== true) {
      throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
    }
    if (procedureId !== objective.procedure?.id) {
      throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
    }
  }
  const registrationBase = applyExplicitCriterionSupersessions(
    objective,
    criteria,
    messages,
    expectedSessionId,
  );
  const merged = validateAndMergeObjectiveAcceptanceCriteria(registrationBase, criteria, now, procedureId);
  assertExactGmailCompletionCriteria(merged, merged.acceptanceCriteria ?? []);
  const existingIds = new Set((registrationBase.acceptanceCriteria ?? []).map(item => item.id));
  const additions = registrationBase.acceptanceNeedsReview ? merged.acceptanceCriteria!
    : merged.acceptanceCriteria!.filter(item => !existingIds.has(item.id));
  // An identical re-registration must preserve old serialized contracts,
  // hashes and timestamps, including contradictions created by older hosts.
  if (!additions.length) return merged;
  assertAdmissibleShellCriteria(additions);
  assertObservedCriterionResultShapes(objective, additions, messages, expectedSessionId);
  if (objective.terminalReconciliation
    && objective.terminalReconciliation.initialAcceptanceRegistrationRequired === true
    && (!objective.acceptanceCriteria?.length || objective.acceptanceNeedsReview === true)) {
    const markerIndexes = (messages ?? []).flatMap((message, index) => (
      message.id === objective.terminalReconciliation!.messageId
        && message.role === 'user' && !message.hidden && !message.internalOrigin
        && !message.agentDelivery && !message.isQueued && !message.isPending ? [index] : []
    ));
    if (markerIndexes.length !== 1) throw new Error(TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR);
    const beforeMarker = [...messages!].slice(0, markerIndexes[0]);
    const observations = collectObjectiveAcceptanceObservations(
      merged,
      beforeMarker,
      expectedSessionId,
    );
    const satisfied = new Set(observations.flatMap(observation => (
      observation.passed && observation.message.toolName
        && canonicalTerminalReconciliationToolInput(observation.message.toolInput) !== undefined
        ? [observation.criterionId] : []
    )));
    if (additions.some(criterion => !satisfied.has(criterion.id))) {
      throw new Error(TERMINAL_RECONCILIATION_INITIAL_EVIDENCE_ERROR);
    }
  }

  const constraints = new Map<string, Map<string, Array<{ criterionId: string; value: unknown }>>>();
  const inspect = (item: ObjectiveAcceptanceCriterion, isAddition: boolean) => {
    const invocation = criterionInvocationIdentity(item);
    let selectors = constraints.get(invocation);
    if (!selectors) { selectors = new Map(); constraints.set(invocation, selectors); }
    for (const check of item.checks) {
      const selector = selectorIdentity(check.path);
      // This is the existing evaluator's equality, not coercion or trimming.
      const value = check.path === '$text' && typeof check.equals === 'string'
        ? withoutFinalLineTerminator(check.equals) : check.equals;
      const previous = selectors.get(selector) ?? [];
      const conflict = isAddition ? previous.find(entry => entry.value !== value) : undefined;
      if (conflict) throw new Error(`Incompatible registered equality: criterion ${item.id} conflicts with ${conflict.criterionId} on selector ${check.path} for the same tool and exact inputs. Registered criteria are unchanged; this rejection does not authorize replacing them or repeating external actions.`);
      previous.push({ criterionId: item.id, value });
      selectors.set(selector, previous);
    }
  };
  // A human revision replaces the old obligation set. Check the complete new
  // set against itself; old contradictory values must not prevent a repair.
  if (!registrationBase.acceptanceNeedsReview) {
    for (const item of registrationBase.acceptanceCriteria ?? []) inspect(item, false);
  }
  for (const item of additions) inspect(item, true);
  assertSatisfiableShellCriteria(merged.acceptanceCriteria!, new Set(additions.map(item => item.id)));
  return merged;
}

/** Evaluation-only repair with a verifiable, value-free provenance diagnostic. */
export function projectObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
): ObjectiveAcceptanceCriteriaProjection & { gscSiteIdentity?: LegacyGscSiteIdentity } {
  const validateOriginal = (criteria: ObjectiveAcceptanceCriterion[]) => {
    try {
      // Historical attestation checks syntax and identity, not today's
      // admission policy. Old contradictory equalities remain contradictory.
      validateAndMergeObjectiveAcceptanceCriteria({ ...objective, terminalState: 'active', acceptanceCriteria: undefined }, criteria,
        objective.acceptanceRegisteredAt);
      return true;
    } catch { return false; }
  };
  return { ...(recoverLegacyAcceptanceScalars(objective, messages, validateOriginal)
    ?? { criteria: objective.acceptanceCriteria ?? [] }),
    gscSiteIdentity: recoverLegacyGscSiteIdentity(objective, messages, validateOriginal),
  };
}

function evaluateObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): { gaps: string[]; evidenceRefs: Set<string> } {
  const evidenceRefs = new Set<string>();
  if (objective.acceptanceNeedsReview) return { evidenceRefs, gaps: ['User requirements changed: re-register the full acceptance contract and observe the current target before completion'] };
  if (objective.procedure && (objective.procedure.version !== 1 || !Object.hasOwn(BUSINESS_PROCEDURES, objective.procedure.id))) {
    return { evidenceRefs, gaps: ['Business procedure version is unavailable; requalification is required'] };
  }
  if (!objective.acceptanceCriteria?.length) return { evidenceRefs, gaps: objective.requiresAcceptanceCriteria
    ? ['Register target-bound acceptance checks with set_completion_criteria before claiming completion'] : [] };
  const rootIndex = messages.findIndex(message => message.id === objective.userMessageId);
  if (rootIndex < 0) return { evidenceRefs, gaps: ['Objective transcript provenance is unavailable'] };
  const scoped = messages.slice(rootIndex + 1);
  const projection = projectObjectiveAcceptanceCriteria(objective, messages);
  const exactGmailGap = exactGmailCompletionCriterionGap(objective, projection.criteria);
  const gaps = [
    ...(exactGmailGap ? [exactGmailGap] : []),
    ...projection.criteria.flatMap(criterion => {
    const binding = projection.gscSiteIdentity?.criterionId === criterion.id ? projection.gscSiteIdentity : undefined;
    const observedAfter = observationBoundary(objective, binding, messages, rootIndex);
    let lastRelevantMutation = -1;
    scoped.forEach((message, index) => {
      if (message.role === 'tool' && message.toolExecuted !== false
        && mutationMayAffectCriterion(message, criterion, projection.criteria)) lastRelevantMutation = index;
    });
    // Only a completed business observation supersedes an earlier one. A
    // transport error, refused invocation or checkpoint contains no newer
    // state and must not erase an exact successful observation. A completed
    // empty or negative result is selected and therefore invalidates a PASS.
    const latestObservation = scoped.findLast((message, index) => message.role === 'tool'
      && !!message.toolName && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
      && observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
      && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
      && !isObjectiveMutationTool(message)
      && (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
        : criterionInputMatchesToolInput(criterion, message.toolInput)));
    const claim = declaration.criteria.find(item => item.id === criterion.id);
    // A tool-name reference is only a compact alias. Resolve it inside this
    // criterion's exact target and chronology, and accept it only when one
    // successful non-mutating invocation is eligible. Exact invocation IDs
    // remain valid when several observations used the same tool.
    const aliasCandidates = claim?.satisfied && claim.evidence.some(ref => ref.startsWith('tool:'))
      ? scoped.filter((message, index) => index > lastRelevantMutation
        && message.role === 'tool' && !!message.toolName
        && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
        && observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        && isObjectiveToolExecutedSuccessfully(message) && !isObjectiveCoordinationTool(message)
        && !isObjectiveMutationTool(message) && message.toolResult !== undefined
        && (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
          : criterionInputMatchesToolInput(criterion, message.toolInput))
        && referencesToolAlias(claim.evidence, message.toolName))
      : [];
    const matched = claim?.satisfied ? scoped.filter((message, index) => {
      const directlyReferenced = claim.evidence.includes(message.id)
        || !!message.toolUseId && claim.evidence.includes(message.toolUseId);
      // Repeating the exact immutable invocation refreshes its observation.
      // Resolve a tool alias to that one latest target-bound result rather than
      // rejecting it merely because an older snapshot of the same target exists.
      const uniquelyResolvedAlias = message === latestObservation
        && aliasCandidates.includes(message)
        && !!message.toolName
        && referencesToolAlias(claim.evidence, message.toolName);
      if (message !== latestObservation || index <= lastRelevantMutation
        || !observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        || !message.toolName || canonicalToolName(message.toolName) !== canonicalToolName(criterion.toolName)
        || !isObjectiveToolExecutedSuccessfully(message) || isObjectiveCoordinationTool(message)
        || isObjectiveMutationTool(message) || message.toolResult === undefined
        || !(directlyReferenced || uniquelyResolvedAlias)) return false;
      if (binding ? !matchesLegacyGscSiteInput(binding, message.toolInput)
        : !criterionInputMatchesToolInput(criterion, message.toolInput)) return false;
      if (binding) return message.toolExecuted === true && !!message.toolUseId
        && scoped.filter(item => item.id === message.id).length === 1
        && scoped.filter(item => item.toolUseId === message.toolUseId).length === 1
        && matchesLegacyGscSiteResult(binding, message.toolResult);
      const result = resultProjection(message, true, expectedSessionId);
      return criterion.checks.every(check => matchesAcceptanceResultCheck(message, result, check));
    }) : [];
    for (const message of matched) {
      evidenceRefs.add(message.id);
      if (message.toolUseId) evidenceRefs.add(message.toolUseId);
    }
    return matched.length ? [] : [`Business criterion lacks matching post-action evidence: ${criterion.id}`];
    }),
  ];
  if (objective.procedure) gaps.push(...businessProcedureCoverage(objective.procedure.id, objective.acceptanceCriteria)
    .map(id => `Business procedure lacks outcome coverage: ${id}`));
  return { gaps, evidenceRefs };
}

export function validateObjectiveAcceptanceCriteria(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): string[] {
  return evaluateObjectiveAcceptanceCriteria(objective, messages, declaration, expectedSessionId).gaps;
}

/** Concrete invocation refs only, verified against the complete registered target-bound check. */
export function collectObjectiveAcceptanceEvidenceRefs(
  objective: ActiveSessionObjective,
  messages: Message[],
  declaration: ObjectiveOutcomeDeclaration,
  expectedSessionId?: string,
): Set<string> {
  return evaluateObjectiveAcceptanceCriteria(objective, messages, declaration, expectedSessionId).evidenceRefs;
}

/**
 * Observations for a delegated audit, including a real negative result. This
 * does not validate business acceptance: the normal validator above still
 * requires every expected value to pass. Only the last invocation of each
 * exact registered target is returned. A newer completed business result
 * supersedes an older snapshot; transport failures and checkpoints do not.
 */
export function collectObjectiveAcceptanceObservations(
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): Array<{ criterionId: string; message: Message; passed: boolean }> {
  const rootIndex = messages.findIndex(message => message.role === 'user' && message.id === objective.userMessageId);
  if (rootIndex < 0) return [];
  const projection = projectObjectiveAcceptanceCriteria(objective, messages);
  const scoped = messages.slice(rootIndex + 1);
  return projection.criteria.flatMap(criterion => {
    const binding = projection.gscSiteIdentity?.criterionId === criterion.id ? projection.gscSiteIdentity : undefined;
    const observedAfter = observationBoundary(objective, binding, messages, rootIndex);
    let lastRelevantMutation = -1;
    let latest: Message | undefined;
    for (const [index, message] of scoped.entries()) {
      if (message.role === 'tool' && message.toolExecuted !== false
        && mutationMayAffectCriterion(message, criterion, projection.criteria)) lastRelevantMutation = index;
      if (!observationIsAfterBoundary(message, rootIndex + 1 + index, observedAfter)
        || !message.toolName || canonicalToolName(message.toolName) !== canonicalToolName(criterion.toolName)
        || message.role !== 'tool' || !isObjectiveToolExecutedSuccessfully(message)
        || isObjectiveCoordinationTool(message) || isObjectiveMutationTool(message)) continue;
      if (binding ? matchesLegacyGscSiteInput(binding, message.toolInput)
        : criterionInputMatchesToolInput(criterion, message.toolInput)) latest = message;
    }
    const latestIndex = latest ? scoped.indexOf(latest) : -1;
    if (!latest || latestIndex <= lastRelevantMutation || latest.toolResult === undefined) return [];
    const result = resultProjection(latest, true, expectedSessionId);
    // Invalid structured output is not an observation of the requested fields.
    if (criterion.checks.some(check => check.path !== '$text') && result === undefined) return [];
    if (binding && (latest.toolExecuted !== true || !latest.toolUseId || messages.filter(item => item.id === latest!.id).length !== 1
      || messages.filter(item => item.toolUseId === latest!.toolUseId).length !== 1)) return [];
    const passed = binding ? matchesLegacyGscSiteResult(binding, latest.toolResult!)
      : criterion.checks.every(check => matchesAcceptanceResultCheck(latest!, result, check));
    return [{ criterionId: criterion.id, message: latest, passed }];
  });
}

/**
 * True only when every registered acceptance target has a current positive
 * host observation. Unlike the broad execution-presence signal, this cannot
 * be satisfied by an unrelated write elsewhere in the objective transcript.
 */
export function hasTargetBoundObjectiveExecutionEvidence(
  objective: ActiveSessionObjective,
  messages: Message[],
  expectedSessionId?: string,
): boolean {
  if (objective.acceptanceNeedsReview) return false;
  const criteria = projectObjectiveAcceptanceCriteria(objective, messages).criteria;
  if (criteria.length === 0) return false;
  const passed = new Set(collectObjectiveAcceptanceObservations(
    objective,
    messages,
    expectedSessionId,
  ).filter(observation => observation.passed).map(observation => observation.criterionId));
  return criteria.every(criterion => passed.has(criterion.id));
}
