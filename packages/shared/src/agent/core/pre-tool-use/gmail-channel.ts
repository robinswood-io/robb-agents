import { isUnknownArray } from '../../../utils/json.ts';
/**
 * Shared PreToolUse utilities and centralized PreToolUse pipeline.
 *
 * Individual utility functions (path expansion, skill qualification, etc.)
 * are used by the centralized `runPreToolUseChecks()` pipeline, which both
 * agent backends (Claude and Pi) call with normalized input and then translate
 * the result to their SDK-specific format. Pi hosts non-Anthropic model
 * providers (OpenAI, GitHub Copilot, Bedrock, etc.) under a single backend,
 * so they inherit this pipeline transparently.
 *
 * Pipeline steps:
 * 1. Permission mode check: Block tools disallowed by current mode
 * 2. Source blocking: Block tools from inactive MCP sources
 * 3. Prerequisite check: Block source tools until guide.md is read
 * 4. call_llm detection: Intercept mcp__session__call_llm
 * 5. Input transforms: Path expansion, config validation, skill qualification, metadata stripping
 * 6. Ask-mode prompt decision: Determine if user approval is needed
 */
import { containsBrowserKeyboardText } from "../../browser-tool-runtime.ts";
import { isCanonicalBrowserToolName } from "../../browser-tool-names.ts";
import { commandFromInput } from './browser-channel.ts';
import type { ToolEffectDescriptor } from './contracts.ts';
import { REMOTE_COMMAND_TOOL_PATTERN } from './tool-names.ts';

export function isBrowserKeyboardText(toolName: string, input: Record<string, unknown>): boolean {
  return isCanonicalBrowserToolName(toolName) && containsBrowserKeyboardText(input["command"]);
}

export function explicitlyNamesGmailBrowserMutation(command: unknown): boolean {
  const text = isUnknownArray(command)
    ? command.filter((part: unknown): part is string => typeof part === 'string').join(' ')
    : typeof command === 'string' ? command : '';
  return /(?:^|[^a-z0-9])(?:gmail|mail\.google\.com)(?:[^a-z0-9]|$)/iu.test(text);
}

const CANONICAL_CONTEXTUAL_GMAIL_MUTATION_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
  'mcp__google-contacts__gmail_reply_bound',
  'mcp__google-contacts__gmail_reply_all',
  // These two are never authorized as the final contextual path, but their
  // dedicated recovery diagnostic is more precise than the generic fallback.
  'mcp__google-contacts__gmail_reply',
  'mcp__google-contacts__gmail_send',
]);

const CONTEXTUAL_GMAIL_COMPLETION_OBSERVATION_TOOLS = new Set([
  'mcp__google-contacts__gmail_connection_healthcheck',
  'mcp__google-contacts__gmail_search',
  'mcp__google-contacts__gmail_search_exact',
  'mcp__google-contacts__gmail_resolve_url',
  'mcp__google-contacts__gmail_get_message',
  'mcp__google-contacts__gmail_get_message_by_url',
  'mcp__google-contacts__gmail_get_unread',
  'mcp__google-contacts__gmail_list_messages',
  'mcp__google-contacts__gmail_recipients_preflight',
  'mcp__google-contacts__gmail_send_preflight',
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
  'mcp__google-contacts__gmail_mark_read_preflight',
  'mcp__google-contacts__gmail_mark_unread_preflight',
  'mcp__google-contacts__gmail_trash_preflight',
  'mcp__google-contacts__gmail_delete_draft_preflight',
  'mcp__google-contacts__gmail_create_draft_preflight',
  'mcp__google-contacts__gmail_verify_sent_message',
  'mcp__google-contacts__gmail_verify_draft',
]);

const SET_COMPLETION_CRITERIA_TOOL_PATTERN = /^(?:mcp__session__|session__)?set_completion_criteria$/;

function containsOnlyContextualGmailCompletionObservations(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!SET_COMPLETION_CRITERIA_TOOL_PATTERN.test(toolName)
    || !isUnknownArray(input["criteria"])
    || input["criteria"].length === 0) return false;
  return input["criteria"].every((value: unknown) => {
    if (!value || typeof value !== 'object' || isUnknownArray(value)) return false;
    const criterion = value as Record<string, unknown>;
    return typeof criterion["toolName"] === 'string'
      && CONTEXTUAL_GMAIL_COMPLETION_OBSERVATION_TOOLS.has(criterion["toolName"]);
  });
}

export function explicitlyNamesNonCanonicalContextualGmailMutation(
  toolName: string,
  input: Record<string, unknown>,
  toolEffect: ToolEffectDescriptor,
): boolean {
  // Registration is host-owned, but MCP read-only annotations describe only
  // the registration call itself. They must never hide a mutating nested
  // criterion from the contextual Gmail guard.
  if (SET_COMPLETION_CRITERIA_TOOL_PATTERN.test(toolName)) {
    return !containsOnlyContextualGmailCompletionObservations(toolName, input);
  }
  if (CANONICAL_CONTEXTUAL_GMAIL_MUTATION_TOOLS.has(toolName)
    || isCanonicalBrowserToolName(toolName)
    || toolEffect.kind === 'read') return false;

  const command = commandFromInput(input) ?? '';
  if ((toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName))
    && (/(?:^|[^a-z0-9])(?:send[_-]?(?:gmail(?:[_-]?reply)?|mail)|gmail[_-]?(?:reply|send)|mail[_-]?reply|dispatch[_-]?reply|smtp|smtplib|sendmail|gmail\s+api|mail\.google\.com|googleapis\.com\/gmail)(?:[^a-z0-9]|$)/iu.test(command)
      || /tell\s+(?:application|app)\s+\\*["']mail\\*["'][^\n]{0,200}\b(?:send|reply)\b/iu.test(command))) {
    return true;
  }

  if (!toolName.startsWith('mcp__') && !toolName.startsWith('api_')) return false;
  const normalizedToolName = toolName.toLowerCase();
  let serializedInput = '';
  try {
    serializedInput = JSON.stringify(input).toLowerCase();
  } catch {
    return true;
  }
  return /(?:^|__|[_-])(?:gmail|email|mail|mailer|smtp|reply)(?:$|__|[_-])/u.test(normalizedToolName)
    || /(?:gmail[_-]?(?:reply|send)|send[_-]?email|reply[_-]?(?:all|email|message)|gmail\.googleapis\.com\/gmail\/v\d+\/[^"\s]+\/messages\/send|smtplib|sendmail)/u.test(serializedInput);
}
