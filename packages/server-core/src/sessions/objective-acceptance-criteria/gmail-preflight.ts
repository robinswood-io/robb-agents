import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { isObjectiveShellExecutorToolName, isReadOnlyRegisteredShellObservation } from "@craft-agent/shared/agent";
import { isObjectiveToolExecutedSuccessfully, isObjectiveMutationTool } from "../objective-contract.ts";
import { atPath, canonicalToolName } from './criterion-identities.ts';
import { criterionChecksTrue, exactEmailSet } from './gmail-completion-contract.ts';
import { resultProjection } from './result-projection.ts';

/**
 * A mutation invalidates one criterion unless its persisted input proves that
 * it targets a different entity/resource. Unknown or broad mutations remain
 * conservative; an explicit mismatching ID/path avoids re-running unrelated
 * checks across the whole objective.
 */
export function exactRegisteredShellObservation(
  message: Message,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): boolean {
  if (!isObjectiveToolExecutedSuccessfully(message) || isObjectiveMutationTool(message)) return false;
  if (!isObjectiveShellExecutorToolName(message.toolName ?? '')) return false;
  const command = [message.toolInput?.["command"], message.toolInput?.["cmd"], message.toolInput?.["script"]]
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
    && value.every((item: unknown, index) => item === expected[index]);
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

const NATIVE_FILE_PATH_TOOLS = new Set(['read', 'write', 'edit']);

export function criterionInputMatchesToolInput(
  criterion: ObjectiveAcceptanceCriterion,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  const canonicalTool = canonicalToolName(criterion.toolName);
  return Object.entries(criterion.input).every(([path, expected]) => {
    let actual = atPath(toolInput, path);
    if (actual === undefined && NATIVE_FILE_PATH_TOOLS.has(canonicalTool)) {
      if (path === 'path' || path === '$.path') {
        actual = atPath(toolInput, 'file_path');
      } else if (path === 'file_path' || path === '$.file_path') {
        actual = atPath(toolInput, 'path');
      }
    }
    return criterionInputValueMatches(criterion.toolName, path, actual, expected);
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
    && value.every((item: unknown, index) => exactGmailAttachmentEffect(item, expected[index]!));
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
export function gmailSendConfirmsPreflightCriterion(
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
    Object.hasOwn(preflightInput, 'attachmentPaths') ? preflightInput["attachmentPaths"] : [],
  );
  if (!preflightAttachments) return false;

  const input = message.toolInput ?? {};
  if (Object.keys(input).some(field => !CANONICAL_GMAIL_SEND_FIELDS.has(field))
    || Object.hasOwn(input, 'from') || Object.hasOwn(input, 'replyTo')) return false;
  const sendAttachments = canonicalGmailAttachmentContract(input["attachmentPaths"]);
  if (!sendAttachments
    || JSON.stringify(sendAttachments.paths) !== JSON.stringify(preflightAttachments.paths)) return false;
  const expectedTo = exactOptionalEmailSet(preflightInput["to"]);
  const expectedCc = exactOptionalEmailSet(preflightInput["cc"]);
  const expectedBcc = exactOptionalEmailSet(preflightInput["bcc"]);
  const actualTo = exactOptionalEmailSet(input["to"]);
  const actualCc = exactOptionalEmailSet(input["cc"]);
  const actualBcc = exactOptionalEmailSet(input["bcc"]);
  if (!expectedTo || !expectedCc || !expectedBcc || !actualTo || !actualCc || !actualBcc
    || expectedTo.length === 0
    || JSON.stringify(actualTo) !== JSON.stringify(expectedTo)
    || JSON.stringify(actualCc) !== JSON.stringify(expectedCc)
    || JSON.stringify(actualBcc) !== JSON.stringify(expectedBcc)) return false;

  const expectedSender = exactEmailSet(preflightInput["sendAsEmail"]);
  // The send receipt exposes the effective mailbox and verified From header,
  // not the optional human-readable label supplied to preflight. Preserve the
  // criterion only when that label contains exactly the same single mailbox;
  // do not claim that the display text itself was observed after the send.
  const expectedFrom = singleMailbox(preflightInput["from"]);
  const actualSender = exactEmailSet(input["sendAsEmail"]);
  if (!expectedSender || expectedSender.length !== 1 || !actualSender
    || JSON.stringify(actualSender) !== JSON.stringify(expectedSender)
    || expectedFrom !== expectedSender[0]) return false;

  for (const field of [
    'subject', 'body', 'isHtml', 'requireKnownContacts', 'allowExternal', 'checkContacts',
  ]) {
    if (!sameJsonScalar(input[field], preflightInput[field])) return false;
  }
  if (typeof preflightInput["subject"] !== 'string' || typeof preflightInput["body"] !== 'string'
    || typeof preflightInput["isHtml"] !== 'boolean'
    || typeof preflightInput["requireKnownContacts"] !== 'boolean'
    || typeof preflightInput["allowExternal"] !== 'boolean'
    || typeof preflightInput["checkContacts"] !== 'boolean') return false;
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
    || atPath(result, '$.subject') !== preflightInput["subject"]
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
    || atPath(result, '$.preflight.subject') !== preflightInput["subject"]
    || atPath(result, '$.preflight.body.isHtml') !== preflightInput["isHtml"]
    || atPath(result, '$.preflight.body.plainLength') !== [...preflightInput["body"]].length
    || !exactStringArray(atPath(result, '$.verification.expected.from'), expectedSender)
    || singleMailbox(atPath(result, '$.verification.expected.fromHeader')) !== expectedSender[0]
    || !exactStringArray(atPath(result, '$.verification.expected.replyTo'), expectedSender)
    || !exactStringArray(atPath(result, '$.verification.expected.to'), expectedTo)
    || !exactStringArray(atPath(result, '$.verification.expected.cc'), expectedCc)
    || atPath(result, '$.verification.expected.subject') !== preflightInput["subject"]
    || !exactStringArray(atPath(result, '$.verification.expected.attachmentNames'), preflightAttachments.names)
    || !exactGmailAttachmentEffects(atPath(result, '$.verification.expected.attachmentEffects'), attachmentEffects)
    || !exactStringArray(atPath(result, '$.verification.attachmentNames'), preflightAttachments.names)
    || !exactGmailAttachmentEffects(atPath(result, '$.verification.attachmentEffects'), attachmentEffects)) return false;

  const embeddedPreflight = atPath(result, '$.preflight');
  return criterion.checks.every(check => check.path === '$text'
    ? false
    : atPath(embeddedPreflight, check.path) === check.equals);
}
