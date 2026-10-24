import { toolNameMutationToken } from "../tool-name-semantics.ts";
import { makeAction } from './action-presentation.ts';
import { extractInputTargets, uniqueTargets } from './action-targets.ts';
import { genericMutationAuthorizationTerms } from './action-vocabulary.ts';
import { CONTEXTUAL_GMAIL_REPLY_TOOL, isCanonicalContextualGmailReplyInput } from './gmail-reply-parsing.ts';
import { UNRESOLVED_EXTERNAL_TARGET, UNRESOLVED_TARGET_SENTINELS } from './host-authorization.ts';
import { hasBoundedSessionPdfAttachment, normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction, SensitiveExternalActionCategory } from './types.ts';

export function normalizedToolAction(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

const READ_ONLY_ACTION_TOKENS = new Set([
  'check',
  'count',
  'describe',
  'fetch',
  'find',
  'get',
  'health',
  'inspect',
  'list',
  'lookup',
  'preflight',
  'preview',
  'query',
  'read',
  'resolve',
  'search',
  'status',
  'validate',
  'verify',
]);

const MUTATING_ACTION_TOKENS = new Set([
  'add',
  'buy',
  'charge',
  'checkout',
  'copy',
  'create',
  'deliver',
  'deploy',
  'deployment',
  'execute',
  'forward',
  'merge',
  'pay',
  'payment',
  'place',
  'post',
  'publish',
  'purchase',
  'put',
  'reply',
  'restart',
  'sell',
  'send',
  'set',
  'share',
  'store',
  'submit',
  'transfer',
  'update',
  'upload',
]);

const COMPOUND_ACTION_TOKENS = new Set([
  'after',
  'and',
  'before',
  'else',
  'or',
  'otherwise',
  'then',
  'unless',
]);

const CONDITIONAL_MUTATION_TOKENS = new Set([
  'absent',
  'missing',
  'needed',
  'necessary',
  'required',
  'unavailable',
]);

function isMutatingActionToken(token: string): boolean {
  return MUTATING_ACTION_TOKENS.has(token) || toolNameMutationToken(token) === token;
}

function hasCompoundMutationBridge(tokens: string[]): boolean {
  if (tokens.some(token => COMPOUND_ACTION_TOKENS.has(token))) return true;
  const ifIndex = tokens.indexOf('if');
  if (ifIndex < 0) return false;
  const condition = tokens.slice(ifIndex + 1);
  return condition.some(token => CONDITIONAL_MUTATION_TOKENS.has(token))
    || condition.some((token, index) => token === 'not' && condition[index + 1] === 'found');
}

/**
 * Detect explicit read-only semantics before looking for mutation keywords.
 *
 * Source tool names often include the operation they inspect, for example
 * `gmail_send_preflight` or `get_send_status`. Looking for `send` alone turns
 * those reads into false-positive external mutations. Preflight/dry-run names
 * are unconditionally non-executing; otherwise the first semantic verb wins,
 * except for explicit compound actions such as `verify_and_send`.
 */
export function isClearlyReadOnlyToolAction(action: string): boolean {
  const tokens = normalizedToolAction(action).split('_').filter(Boolean);

  const explicitReadOnlyIndex = tokens.findIndex((token, index) =>
    token === 'preflight'
    || token === 'dryrun'
    || (token === 'dry' && tokens[index + 1] === 'run')
  );
  if (explicitReadOnlyIndex >= 0) {
    const laterMutationIndex = tokens.findIndex((token, index) =>
      index > explicitReadOnlyIndex && isMutatingActionToken(token)
    );
    if (laterMutationIndex < 0) return true;
    if (!hasCompoundMutationBridge(tokens.slice(explicitReadOnlyIndex + 1, laterMutationIndex))) return true;
  }

  const firstIntentIndex = tokens.findIndex(token =>
    READ_ONLY_ACTION_TOKENS.has(token) || isMutatingActionToken(token)
  );
  if (firstIntentIndex < 0 || !READ_ONLY_ACTION_TOKENS.has(tokens[firstIntentIndex]!)) return false;

  const laterMutationIndex = tokens.findIndex((token, index) =>
    index > firstIntentIndex && isMutatingActionToken(token)
  );
  if (laterMutationIndex < 0) return true;

  // `get_send_status` is a read, whereas `verify_and_send` is a compound
  // mutation. Keep the latter fail-closed.
  return !hasCompoundMutationBridge(tokens.slice(firstIntentIndex + 1, laterMutationIndex));
}

const ATRIA_GRAPH_REQUEST_TOOL = 'mcp__atria-microsoft-365__graph_request';

export const GMAIL_SEND_TOOL = 'mcp__google-contacts__gmail_send';

export const BOUNDED_OSS_ATOMIC_WRITE_TOOL = 'mcp__rbw-agents-oss__oss_write_file';

export const BOUNDED_OSS_ATOMIC_WRITE_ROOT = '/srv/rbw-agents-oss/scripts';

const GRAPH_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const ATRIA_APP_CONSENT_APPROVAL_ENDPOINT = new RegExp(
  `^identityGovernance/appConsent/appConsentRequests/(${GRAPH_UUID})/userConsentRequests/(${GRAPH_UUID})/approval/stages/(${GRAPH_UUID})$`,
  'i',
);

const ATRIA_APP_CONSENT_APPROVAL_TERMS = [[
  'approve', 'approves', 'approved', 'approval', 'approuve', 'approuver', 'approuvez',
  'validate', 'validates', 'validated', 'valide', 'valider', 'validez',
]];

export function safePermissionPromptValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) return fallback;
  const trimmed = value.trim();
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential)\b\s*[:=]/iu.test(trimmed)) {
    return '[REDACTED]';
  }
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function exactGmailSendPermissionPreview(
  toolName: string,
  input: Record<string, unknown>,
  targets: readonly string[],
): string | undefined {
  if (toolName !== GMAIL_SEND_TOOL) return undefined;
  const sender = safePermissionPromptValue(input.sendAsEmail, '[default account]');
  const recipients = targets.filter(target => !UNRESOLVED_TARGET_SENTINELS.has(target)).join(', ')
    || '[unresolved recipient]';
  const subject = safePermissionPromptValue(input.subject, '[no subject]');
  return `${toolName} sender=${JSON.stringify(sender)} recipients=${JSON.stringify(recipients)} subject=${JSON.stringify(subject)}`;
}

function exactAtriaApprovalPermissionPreview(
  endpoint: string,
  input: Record<string, unknown>,
): string {
  const body = input.body as Record<string, unknown>;
  const ids = ATRIA_APP_CONSENT_APPROVAL_ENDPOINT.exec(endpoint);
  return [
    `${ATRIA_GRAPH_REQUEST_TOOL} PATCH ${endpoint}`,
    `authMode=${JSON.stringify(String(input.authMode))}`,
    `appConsentRequestId=${JSON.stringify(ids?.[1] ?? '[unresolved]')}`,
    `userConsentRequestId=${JSON.stringify(ids?.[2] ?? '[unresolved]')}`,
    `approvalStageId=${JSON.stringify(ids?.[3] ?? '[unresolved]')}`,
    `reviewResult=${JSON.stringify(safePermissionPromptValue(body.reviewResult, '[unresolved]'))}`,
    `justification=${JSON.stringify(safePermissionPromptValue(body.justification, '[REDACTED]'))}`,
  ].join(' ');
}

function exactAtriaAppConsentApprovalEndpoint(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== ATRIA_GRAPH_REQUEST_TOOL) return undefined;
  const allowedRootKeys = new Set([
    'method', 'endpoint', 'body', 'authMode', '_displayName', '_intent',
  ]);
  if (Object.keys(input).some(key => !allowedRootKeys.has(key))) return undefined;
  if (typeof input.method !== 'string' || input.method.trim().toUpperCase() !== 'PATCH'
    || input.authMode !== 'delegated'
    || typeof input.endpoint !== 'string') return undefined;

  const endpoint = input.endpoint.trim();
  const match = ATRIA_APP_CONSENT_APPROVAL_ENDPOINT.exec(endpoint);
  // This recovery is deliberately limited to the exact live leaf route. A
  // collection, wildcard, opaque path or differently shaped approval remains
  // blocked so the agent must resolve it with graph_get first.
  if (!match || match[2]?.toLowerCase() !== match[3]?.toLowerCase()) return undefined;

  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return undefined;
  const body = input.body as Record<string, unknown>;
  if (Object.keys(body).length !== 2
    || !Object.hasOwn(body, 'reviewResult')
    || !Object.hasOwn(body, 'justification')
    || body.reviewResult !== 'Approve'
    || typeof body.justification !== 'string'
    || body.justification.trim().length === 0
    || body.justification.length > 1_000
    || /[\0\r\n]/.test(body.justification)) return undefined;
  const normalizedJustification = normalizeForMatch(body.justification);
  if (!/\bfranck\b/u.test(normalizedJustification)
    || !/\bchat ?gpt\b/u.test(normalizedJustification)
    || !/\batria\b/u.test(normalizedJustification)) return undefined;
  return endpoint;
}

export function classifyMcp(
  toolName: string,
  input: Record<string, unknown>,
  targetOverride?: string[],
  allowImplementationAliases = false,
): SensitiveExternalAction | null {
  if (toolName.startsWith('mcp__session__') || toolName.startsWith('mcp__craft-agents-docs__')) return null;
  if (toolName.includes('__api_')) return classifyApi(toolName, input);

  const atriaApprovalEndpoint = exactAtriaAppConsentApprovalEndpoint(toolName, input);
  if (atriaApprovalEndpoint) {
    return makeAction(
      'external_mutation',
      'mcp_mutation',
      exactAtriaApprovalPermissionPreview(atriaApprovalEndpoint, input),
      [atriaApprovalEndpoint],
      ATRIA_APP_CONSENT_APPROVAL_TERMS,
    );
  }

  const action = normalizedToolAction(toolName.split('__').slice(2).join('_'));
  const inputActions = [input.action, input.operation]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const inputCategories = [...new Set(inputActions
    .map(value => apiSensitiveCategory(normalizedToolAction(value)))
    .filter((value): value is SensitiveExternalActionCategory => !!value))];
  const inputCategory = inputCategories.length === 1 ? inputCategories[0]! : null;
  const inputCategoryConflict = inputCategories.length > 1;
  const strictInputSend = inputCategories.includes('external_send');
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
  const inputMutationToken = inputActions
    .map(value => toolNameMutationToken(value))
    .find((value): value is string => !!value);
  const methodMutationToken = method === 'DELETE'
    ? 'delete'
    : method === 'PATCH' || method === 'PUT'
      ? 'update'
      : method === 'POST'
        ? 'post'
        : undefined;
  if (isClearlyReadOnlyToolAction(action) && !inputMutationToken
    && !methodMutationToken && inputCategories.length === 0) return null;
  const boundedSessionPdfAttachment = toolName === GMAIL_SEND_TOOL
    && hasBoundedSessionPdfAttachment(input);
  const make = (category: SensitiveExternalActionCategory, authorizationTermGroups?: string[][]) => {
    const contextualReplyTargets = category === 'external_send'
      && isCanonicalContextualGmailReplyInput(toolName, input)
      ? [
        String(input.messageId),
        ...(toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
          ? [String(input.expectedRecipientEmail)]
          : []),
      ]
      : undefined;
    const targets = targetOverride ?? contextualReplyTargets ?? extractInputTargets(input, {
      strictExternalSend: category === 'external_send' || strictInputSend,
      canonicalGmailSend: toolName === GMAIL_SEND_TOOL,
    });
    const classified = makeAction(
      category,
      'mcp_mutation',
      exactGmailSendPermissionPreview(toolName, input, targets) ?? toolName,
      targets,
      authorizationTermGroups,
    );
    return {
      ...classified,
      ...(boundedSessionPdfAttachment
        ? { boundedSessionPdfAttachment: true as const } : {}),
    };
  };

  if (inputCategoryConflict) {
    return makeAction(
      'external_mutation',
      'mcp_mutation',
      toolName,
      uniqueTargets([
        ...(targetOverride ?? extractInputTargets(input, {
          strictExternalSend: strictInputSend,
          canonicalGmailSend: toolName === GMAIL_SEND_TOOL,
        })),
        UNRESOLVED_EXTERNAL_TARGET,
      ]),
      [['conflicting sensitive input operations require explicit resolution']],
    );
  }

  if (/(?:^|_)(?:set|put|create|update|upload|add|store|copy|transfer)_(?:[^_]+_)*(?:secret|credential|token|api_key|private_key)(?:_|$)/.test(action)
    || /(?:^|_)(?:secret|credential|token|api_key|private_key)_(?:set|put|create|update|upload|add|store|copy|transfer)(?:_|$)/.test(action)) return make('secret_transfer');
  if (/(?:^|_)(?:pay|payment|charge|purchase|checkout|payout|financial_transfer|transfer_funds|place_order|execute_trade|buy|sell)(?:_|$)/.test(action)
    || /(?:^|_)(?:create|place|submit|execute|transfer)_(?:payment|charge|purchase|checkout|payout|funds|order|trade)(?:_|$)/.test(action)) return make('payment');
  if (/(?:^|_)(?:deploy|deployment)(?:_|$)/.test(action)) return make('deployment');
  if (/(?:^|_)(?:restart|restart_service|rollout_restart)(?:_|$)/.test(action)) return make('service_restart');
  if (/(?:^|_)git_push(?:_|$)/.test(action)) return make('git_push');
  if (/(?:^|_)(?:send|deliver|forward|reply)(?:_|$)/.test(action)) return make('external_send');
  if (/(?:^|_)(?:publish|share|make_public)(?:_|$)/.test(action)
    || /(?:^|_)(?:create|add|post|submit|merge)_(?:post|comment|issue|pull_request|release|review|announcement)(?:_|$)/.test(action)) return make('external_publication');
  // Generic connector verbs (`execute`, `perform`, `request`) often carry the
  // real operation in the authenticated input. Preserve its sensitive
  // category so an operation=send call receives the strict audience parser
  // instead of the looser generic-mutation target extraction.
  if (inputCategory && inputCategory !== 'external_mutation') return make(inputCategory);
  const mutationToken = toolNameMutationToken(action)
    ?? inputMutationToken
    ?? methodMutationToken;
  if (mutationToken || method && /^(?:DELETE|PATCH|POST|PUT)$/.test(method)) {
    return make('external_mutation', genericMutationAuthorizationTerms(
      mutationToken,
      allowImplementationAliases,
    ));
  }
  return null;
}

function pathTargets(path: string | undefined): string[] {
  if (!path) return [];
  const genericSegments = new Set([
    'api', 'v1', 'v2', 'v3', 'repos', 'messages', 'emails', 'posts', 'comments', 'issues',
    'pulls', 'releases', 'payments', 'charges', 'transfers', 'orders', 'trades', 'secrets',
    'credentials', 'tokens', 'deployments', 'restart', 'send', 'publish',
    'contacts', 'get-status', 'jobs', 'read', 'records', 'search', 'status', 'todos', 'users',
  ]);
  const segments = path
    .split(/[/?#]/)
    .map(segment => segment.trim())
    .filter(segment => segment && !genericSegments.has(segment.toLowerCase()));
  return segments.length > 0 ? [segments.slice(-2).join(' ')] : [];
}

function apiSensitiveCategory(semantic: string): SensitiveExternalActionCategory | null {
  if (/(?:^|_)(?:secret|secrets|credential|credentials|token|tokens|api_key|api_keys)(?:_|$)/.test(semantic)) return 'secret_transfer';
  if (/(?:^|_)(?:payment|payments|charge|charges|checkout|payout|payouts|financial_transfer|transfer_funds|funds_transfer|transfers|purchase|orders|trade|trades|buy|sell)(?:_|$)/.test(semantic)) return 'payment';
  if (/(?:^|_)(?:deploy|deploys|deployment|deployments)(?:_|$)/.test(semantic)) return 'deployment';
  if (/(?:^|_)(?:restart|restarts)(?:_|$)/.test(semantic)) return 'service_restart';
  if (/(?:^|_)(?:send|deliver|forward|reply|messages|emails|notifications|invites)(?:_|$)/.test(semantic)) return 'external_send';
  if (/(?:^|_)(?:publish|posts|comments|issues|pulls|releases|reviews|shares)(?:_|$)/.test(semantic)) return 'external_publication';
  return null;
}

export function classifyApi(toolName: string, input: Record<string, unknown>): SensitiveExternalAction | null {
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
  const path = typeof input.path === 'string' ? input.path : '';
  const operation = typeof input.operation === 'string' ? input.operation : '';
  const operationMutationToken = toolNameMutationToken(operation);
  const operationCategory = apiSensitiveCategory(normalizedToolAction(operation));
  // A transport-level read method cannot override an explicitly mutating API
  // operation. Some connectors expose categorized mutations such as `restart`,
  // `charge`, or `deliver` through a GET-shaped RPC envelope, so preserve the
  // operation as the authority source even when it has no generic mutation token.
  if (['GET', 'HEAD', 'OPTIONS'].includes(method) && !operationMutationToken && !operationCategory) return null;
  if (method === 'POST' && path && isClearlyReadOnlyToolAction(normalizedToolAction(path))
    && !operationMutationToken && !operationCategory) return null;
  const semantic = normalizedToolAction(`${toolName}_${operation}_${path}`);
  const category = apiSensitiveCategory(semantic);
  const structuredTargets = extractInputTargets(input, { strictExternalSend: category === 'external_send' });
  const canonicalPathTargets = pathTargets(path);
  const normalizedStructuredTargets = new Set(structuredTargets.map(normalizeForMatch));
  const distinctPathTargets = canonicalPathTargets.filter(target =>
    !normalizedStructuredTargets.has(normalizeForMatch(target))
  );
  const targets = uniqueTargets([
    ...structuredTargets,
    ...distinctPathTargets,
    ...(structuredTargets.length === 0 && distinctPathTargets.length === 0 && path ? [path] : []),
  ]);
  const preview = `${method} ${path || toolName}`;
  const make = (category: SensitiveExternalActionCategory) =>
    makeAction(category, 'api_mutation', preview, targets);

  if (category) return make(category);
  const mutationToken = operationMutationToken
    ?? toolNameMutationToken(path)
    ?? (method === 'DELETE' ? 'delete' : method === 'PATCH' || method === 'PUT' ? 'update' : method === 'POST' ? 'post' : undefined);
  return makeAction(
    'external_mutation', 'api_mutation', preview, targets,
    genericMutationAuthorizationTerms(mutationToken),
  );
}
