/// <reference path="../bash-parser.d.ts" />

import bashParser from 'bash-parser';
import { posix } from 'node:path';
import { hasSingleMailboxShape } from '../../utils/string-boundaries.ts';
import {
  isProvablyReadOnlyShellCommand,
  isReadOnlyRegisteredShellObservation,
} from './registered-observation.ts';
import { toolNameMutationToken } from './tool-name-semantics.ts';

export type SensitiveExternalActionCategory =
  | 'git_push'
  | 'deployment'
  | 'service_restart'
  | 'secret_transfer'
  | 'external_send'
  | 'external_publication'
  | 'external_mutation'
  | 'payment';

export type SensitiveConditionalTargetKind = 'contract' | 'document' | 'envelope';

export interface SensitiveConditionalTarget {
  kind: SensitiveConditionalTargetKind;
  value: string;
}

export interface SensitiveExternalAction {
  category: SensitiveExternalActionCategory;
  promptType: 'bash' | 'mcp_mutation' | 'api_mutation';
  description: string;
  commandPreview: string;
  reason: string;
  impact: string;
  targetCandidates: string[];
  /**
   * Internal object identifiers that bind authority only when the objective
   * explicitly names the same kind of object. They are deliberately separate
   * from the always-required external audience.
   */
  conditionalTargetCandidates?: SensitiveConditionalTarget[];
  /** Operation-specific verbs for generic connector/API mutations. */
  authorizationTermGroups?: string[][];
  /** Host-owned marker for a shell command transported by a remote executor. */
  remoteCommand?: true;
  /** Only the audited rbw-servers executors may use the bounded Orion prompt. */
  boundedRemoteHostPrompt?: true;
  /** Literal rbw-servers endpoint/cwd retained out of band from the lossy
   * target display classifier. These fields are emitted only for the two
   * audited executors and never inferred from objective prose. */
  boundedRemoteEndpoint?: string;
  boundedRemoteWorkingDirectory?: string;
  /** Every shell leaf belongs to the closed source/test/deploy lifecycle
   * grammar. Opaque wrappers/interpreters and unrelated clients are excluded. */
  boundedRemoteImplementationLifecycle?: true;
  /** A read-shaped remote command contains an option that writes a file,
   * loads executable configuration, or launches a secondary command. */
  boundedRemoteReadSideEffect?: true;
  /** One PDF resolved from the current session may accompany this canonical
   * Gmail send, but only when the authenticated objective names that PDF. */
  boundedSessionPdfAttachment?: true;
  /** Exact atomic OSS source write admitted only by a signed resume contract.
   * The connector, literal canonical path and input shape are all closed. */
  boundedOssAtomicWrite?: true;
  /** Mixed sensitive operations whose redacted preview cannot support informed consent. */
  requiresInspectableSplit?: true;
}

interface AstNode {
  type: string;
  async?: boolean;
  op?: string | { text?: string };
  commands?: AstNode[];
  left?: AstNode;
  right?: AstNode;
  list?: AstNode;
  name?: { type: string; text: string };
  suffix?: Array<{
    type: string;
    text?: string;
    expansion?: unknown[];
    file?: { type?: string; text?: string; expansion?: unknown[] };
    op?: { text?: string };
  }>;
}

const ACTION_DETAILS: Record<SensitiveExternalActionCategory, {
  description: string;
  reason: string;
  impact: string;
  authorizationTermGroups: string[][];
}> = {
  git_push: {
    description: 'Push commits to a remote Git repository',
    reason: 'A push changes a remote repository and requires explicit authorization for its target.',
    impact: 'Remote branches, reviews, or deployment automation may be changed or triggered.',
    authorizationTermGroups: [['push', 'pousse', 'pousser']],
  },
  deployment: {
    description: 'Deploy to an external environment',
    reason: 'A deployment changes a remote environment and requires explicit authorization for its target.',
    impact: 'Production or another shared environment may be modified and users may be affected.',
    authorizationTermGroups: [['deploy', 'deployment', 'deploiement', 'deploie', 'deployer', 'publie la version', 'release']],
  },
  service_restart: {
    description: 'Start or restart an external service',
    reason: 'Starting or restarting a service can affect availability and requires explicit authorization for the service.',
    impact: 'Active requests or users may experience downtime or partial failure.',
    authorizationTermGroups: [[
      'start', 'demarre', 'demarrer',
      'restart', 'redemarre', 'redemarrer', 'relance', 'relancer',
    ]],
  },
  secret_transfer: {
    description: 'Transfer or write a secret to an external system',
    reason: 'Moving credentials outside local secure storage requires explicit authorization for the destination.',
    impact: 'A credential may be disclosed, persisted remotely, or grant access to production resources.',
    authorizationTermGroups: [
      ['copy', 'copie', 'copier', 'transfer', 'transfere', 'transferer', 'write', 'ecris', 'ecrire', 'set', 'configure', 'ajoute', 'ajouter', 'upload'],
      ['secret', 'credential', 'identifiant', 'token', 'api key', 'cle', 'private key', 'mot de passe'],
    ],
  },
  external_send: {
    description: 'Send content to an external recipient',
    reason: 'Sending content acts on an external audience and requires explicit authorization for the recipient.',
    impact: 'A message, email, invitation, or notification will be delivered outside this chat.',
    authorizationTermGroups: [[
      'send', 'envoie', 'envoyer', 'reply to', 'reponds', 'repondre a', 'forward',
      'transmets', 'transmettre',
    ]],
  },
  external_publication: {
    description: 'Publish content to an external audience',
    reason: 'Publishing content changes an external system and requires explicit authorization for the audience or target.',
    impact: 'A post, comment, issue, review, release, or shared resource may become visible to others.',
    authorizationTermGroups: [[
      'publish', 'publie', 'publier', 'post', 'poste', 'poster', 'add comment', 'ajoute un commentaire',
      'commente', 'comment on', 'share', 'partage', 'create issue', 'cree une issue', 'open issue',
      'ouvre une issue', 'create pull request', 'cree une pull request', 'merge pull request',
      'fusionne la pull request', 'submit review', 'publie la release',
    ]],
  },
  external_mutation: {
    description: 'Modify an external system',
    reason: 'An external mutation requires explicit authorization for both its operation and concrete target.',
    impact: 'A remote record, workflow, or shared system may be changed.',
    authorizationTermGroups: [['mutate', 'modifie', 'modifier']],
  },
  payment: {
    description: 'Submit a payment or financial transaction',
    reason: 'A financial submission requires explicit authorization for the recipient, account, or instrument.',
    impact: 'Funds, an order, a trade, or another financial commitment may be created or transferred.',
    authorizationTermGroups: [[
      'pay', 'paie', 'payer', 'make payment', 'effectue le paiement', 'purchase', 'buy', 'achete',
      'acheter', 'transfer funds', 'financial transfer', 'virement', 'charge card', 'charge customer',
      'place order', 'passe la commande', 'execute trade', 'sell', 'vendre',
    ]],
  },
};

const TARGET_FIELD_NAMES = new Set([
  'to',
  'cc',
  'ccs',
  'bcc',
  'bccs',
  'blind_copy',
  'blind_copies',
  'carbon_copy',
  'carbon_copies',
  'recipient',
  'recipients',
  'recipient_id',
  'recipient_ids',
  'recipient_email',
  'recipient_emails',
  'recipient_selector',
  'recipient_selectors',
  'recipient_glob',
  'recipient_globs',
  'recipients_glob',
  'recipients_globs',
  'distribution_list',
  'distribution_lists',
  'signatory',
  'signatories',
  'signatory_id',
  'signatory_ids',
  'email',
  'emails',
  'channel',
  'channels',
  'channel_id',
  'channel_ids',
  'chat',
  'chats',
  'chat_id',
  'chat_ids',
  'audience',
  'audiences',
  'audience_id',
  'audience_ids',
  'target',
  'targets',
  'destination',
  'destinations',
  'repo',
  'repository',
  'environment',
  'service',
  'project',
  'account',
  'accounts',
  'account_id',
  'account_ids',
  'merchant',
  'merchants',
  'beneficiary',
  'beneficiaries',
  'beneficiary_id',
  'beneficiary_ids',
  'counterparty',
  'counterparties',
  'counterparty_id',
  'counterparty_ids',
  'payee',
  'payees',
  'payee_id',
  'payee_ids',
  'amount',
  'currency',
  'instrument',
  'customer',
  'customers',
  'customer_id',
  'customer_ids',
  'user',
  'users',
  'user_id',
  'user_ids',
  'username',
  'team',
  'organization',
  'org',
  'room',
  'rooms',
  'room_id',
  'room_ids',
  'conversation',
  'conversations',
  'conversation_id',
  'conversation_ids',
  'thread',
  'threads',
  'thread_id',
  'thread_ids',
  'group',
  'groups',
  'group_id',
  'group_ids',
  'mailing_list',
  'mailing_lists',
  'subscriber',
  'subscribers',
  'subscriber_id',
  'subscriber_ids',
  'invitee',
  'invitees',
  'invitee_id',
  'invitee_ids',
  'queue',
  'queues',
  'topic',
  'topics',
  'routing_key',
  'routing_keys',
  'webhook_url',
  'webhook_urls',
  'endpoint_url',
  'endpoint_urls',
  'host',
  'server',
  'remote',
  'branch',
  'app',
  'application',
  'namespace',
  'symbol',
]);

const UNRESOLVED_REMOTE_SCOPE = 'unresolved remote scope';
const UNRESOLVED_EXTERNAL_TARGET = 'unresolved external target';
const UNRESOLVED_EXTERNAL_AUDIENCE = 'unresolved external audience';
const ADDITIONAL_UNRESOLVED_TARGETS = 'additional unresolved targets';
const UNRESOLVED_TARGET_SENTINELS = new Set([
  UNRESOLVED_REMOTE_SCOPE,
  UNRESOLVED_EXTERNAL_TARGET,
  UNRESOLVED_EXTERNAL_AUDIENCE,
  ADDITIONAL_UNRESOLVED_TARGETS,
]);
const HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER = '[host-authenticated-user-authorization:v1]';

function parseHostAuthenticatedUserAuthorization(rawRequest: string): {
  questionId: string;
  selection: string;
  displayedScope: string;
} | undefined {
  const lines = rawRequest.split('\n');
  if (lines.length !== 4 || lines[0] !== HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER) {
    return undefined;
  }
  const questionIdPrefix = 'Authenticated question id: ';
  const selectionPrefix = 'The user affirmatively selected: ';
  const scopePrefix = 'Displayed scope affirmed by that selection: ';
  if (!lines[1]?.startsWith(questionIdPrefix)
    || !lines[2]?.startsWith(selectionPrefix)
    || !lines[3]?.startsWith(scopePrefix)) return undefined;
  const questionId = lines[1].slice(questionIdPrefix.length).trim();
  const selection = lines[2].slice(selectionPrefix.length).trim();
  const displayedScope = lines[3].slice(scopePrefix.length).trim();
  if (!questionId || !selection || !displayedScope
    || questionId.length > 256 || selection.length > 4_096
    || displayedScope.length > 16_384) return undefined;
  return { questionId, selection, displayedScope };
}

function hostAuthenticatedAuthorizationContainsNoEffectDirective(
  authenticated: ReturnType<typeof parseHostAuthenticatedUserAuthorization>,
  action: SensitiveExternalAction,
): boolean {
  if (!authenticated) return true;
  const text = normalizeForMatch(`${authenticated.selection}. ${authenticated.displayedScope}`);
  // A global no-op always wins, even when a later sentence repeats the
  // displayed action. This protects legacy host markers already persisted by
  // an older renderer.
  if (/\b(?:ne|n) (?:fais|faites|faire) (?:absolument )?rien\b|\b(?:ne|n) rien faire\b|\baucune action\b|\bdo (?:absolutely )?nothing\b|\b(?:do not|don t) do anything\b/u.test(text)) {
    return true;
  }

  // Other restrictions are action-specific. “Envoyer … et ne modifie rien
  // d'autre” authorizes the send but explicitly denies a separate mutation.
  const terms = (action.authorizationTermGroups
    ?? ACTION_DETAILS[action.category].authorizationTermGroups).flat();
  return terms.some((term) => {
    const normalizedTerm = normalizeForMatch(term);
    if (!normalizedTerm) return false;
    const actionTerm = normalizedTerm.split(/\s+/u)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('\\s+');
    return new RegExp(`\\b(?:sans (?:aucun |aucune )?|without (?:any )?)${actionTerm}\\b`, 'u').test(text)
      || new RegExp(`\\b(?:pas de|sauf|hors|except|excluding) ${actionTerm}\\b`, 'u').test(text)
      || new RegExp(`\\b(?:ne|n)\\b.{0,80}\\b${actionTerm}\\b.{0,80}\\b(?:pas|jamais|plus|rien)\\b`, 'u').test(text)
      || new RegExp(`\\b(?:ne|n)\\s+(?:pas|jamais|plus|rien)\\b.{0,80}\\b${actionTerm}\\b`, 'u').test(text)
      || new RegExp(`\\b(?:do not|don t|never)\\b.{0,80}\\b${actionTerm}\\b`, 'u').test(text)
      || new RegExp(`\\b${actionTerm}\\s+(?:absolutely\\s+)?nothing\\b`, 'u').test(text);
  });
}

function genericHostAuthenticatedUserAuthorization(
  action: SensitiveExternalAction,
  rawRequest: string,
): boolean {
  const authenticated = parseHostAuthenticatedUserAuthorization(rawRequest);
  if (!authenticated || hostAuthenticatedAuthorizationContainsNoEffectDirective(authenticated, action)
    || action.remoteCommand
    || action.targetCandidates.length === 0
    || action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;
  const affirmed = `${authenticated.selection}. ${authenticated.displayedScope}`;
  const normalized = normalizeForMatch(affirmed);
  if (!normalized || hasGlobalExternalActionRevocation(affirmed)
    || !requestNamesSensitiveActionCategory(action, normalized)
    || !requestMatchesConditionalTargets(action, affirmed)) return false;
  const clauses = requestClauses(affirmed);
  return action.targetCandidates.every(target => (
    targetIsNamed(affirmed, target)
    && !clauses.some(clause => targetIsNamed(clause, target)
      && targetIsNegatedInClause(clause, target))
  ));
}

export function hasUnresolvedRemoteScopeTarget(
  action: SensitiveExternalAction,
): boolean {
  return action.targetCandidates.includes(UNRESOLVED_REMOTE_SCOPE);
}

export function hasUnresolvedSensitiveExternalActionTarget(
  action: SensitiveExternalAction,
): boolean {
  return action.targetCandidates.length === 0
    || action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target));
}

/** The raw body remains available only to the closed Gmail payload matcher.
 * Every generic external-action classifier sees it as inert data so quoted
 * commands cannot authorize a different tool category or target. */
function structuredGmailPolicyRequest(rawRequest: string): string {
  if (!parseStructuredGmailSendResumeSegment(rawRequest)) return rawRequest;
  const start = rawRequest.indexOf('BODY_BEGIN\n') + 'BODY_BEGIN\n'.length;
  const end = rawRequest.indexOf('\nBODY_END', start);
  return `${rawRequest.slice(0, start)}[exact Gmail payload body omitted from generic action authority]${rawRequest.slice(end)}`;
}

export function externalActionAuthorityPolicySegments(segments: readonly string[]): string[] {
  return segments.map(structuredGmailPolicyRequest);
}

export function isSensitiveExternalActionOtherwiseAuthorizedByObjective(
  action: SensitiveExternalAction,
  authorizationSegments: readonly string[],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(authorizationSegments);
  if (!hasUnresolvedRemoteScopeTarget(action)) return false;
  const concreteTargets = action.targetCandidates.filter(
    target => target !== UNRESOLVED_REMOTE_SCOPE,
  );
  if (concreteTargets.length === 0) return false;
  const candidateTargetSets = [concreteTargets];
  const promptAction = action.boundedRemoteHostPrompt && action.category === 'external_mutation'
    ? {
      ...action,
      authorizationTermGroups: [[...new Set([
        ...(action.authorizationTermGroups ?? []).flat(),
        ...ACTION_DETAILS.external_mutation.authorizationTermGroups[0]!,
        ...IN_SCOPE_IMPLEMENTATION_ALIASES,
      ])]],
    }
    : action;
  return candidateTargetSets.some(targetCandidates => (
    isSensitiveExternalActionConfirmationRequestedByObjective(
      { ...promptAction, targetCandidates }, policySegments,
    ) || isSensitiveExternalActionAuthorizedByObjective(
      { ...promptAction, targetCandidates }, policySegments,
    )
  ));
}

function hasDynamicOrGlobTargetSyntax(value: string): boolean {
  return /[$`*?[\]{}~]/u.test(value) || /[\0\r\n]/u.test(value);
}

const GENERIC_CONTINUATIONS = new Set([
  'continue',
  'continue please',
  'please continue',
  'proceed',
  'please proceed',
  'go ahead',
  'carry on',
  'resume',
  'poursuis',
  'poursuivez',
  'continuez',
  'vas y',
  'allez y',
  'reprends',
]);

const NON_AUTHORIZING_QUESTION_PREFIX = /^(?:how|what|why|when|where|who|which|can (?:i|we|you)|could (?:i|we|you)|would (?:i|we|you)|should (?:i|we|you)|do (?:i|we|you)|does|did|will (?:i|we|you)|comment|pourquoi|quand|ou|qui|quel|quelle|peux tu|pouvez vous|dois je|est ce|faut il)\b/;
const NON_AUTHORIZING_INFORMATION_PREFIX = /^(?:analy[sz]e|analyser|assess|evaluate|evalue|evaluer|review|inspect|inspecte|inspecter|explain|explique|expliquer|describe|decris|decrire|summarize|resume|resumer|investigate|examine|examiner|compare|comparer|show me|montre moi|tell me|dis moi|give me|donne moi|plan|planifie|planifier|propose|document|documente)\b/;
function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? value.toLowerCase();
}

function uniqueTargets(values: Array<string | undefined>): string[] {
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

function isCanonicalEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !hasSingleMailboxShape(value) || /\0/u.test(value)) return false;
  const at = value.indexOf('@');
  const dot = value.lastIndexOf('.');
  const host = value.slice(at + 1, dot);
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(value.slice(0, at))
    && /^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(host)
    && /[A-Za-z0-9]$/u.test(host)
    && /^[A-Za-z]{2,}$/u.test(value.slice(dot + 1));
}

function isBoundedSessionPdfAttachmentPath(path: unknown): path is string {
  if (typeof path !== 'string' || path !== path.trim() || path.length > 600) return false;
  const match = /^\{\{SESSION_PATH\}\}\/(?:downloads|long_responses)\/(.+\.pdf)$/u.exec(path);
  if (!match?.[1]) return false;
  const relativePath = match[1];
  // Keep the symbolic session root literal and reject every path spelling that
  // could normalize to another target. Each nested component must be ordinary
  // ASCII file-name data and the final component must remain a lowercase PDF.
  return posix.normalize(relativePath) === relativePath
    && relativePath.split('/').every(component => (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(component)
      && component !== '.'
      && component !== '..'
    ));
}

function hasBoundedSessionPdfAttachment(input: Record<string, unknown>): boolean {
  if (!Array.isArray(input.attachmentPaths) || input.attachmentPaths.length !== 1) return false;
  // The symbolic session root is resolved by the host and cannot escape into
  // another task. Limit this authority recovery to one ordinary PDF beneath
  // the two directories used for connector downloads and long results.
  return isBoundedSessionPdfAttachmentPath(input.attachmentPaths[0]);
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
      if (!Array.isArray(value)
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

function extractInputTargets(
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
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    for (const [rawKey, entry] of Object.entries(value)) {
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
        if (Array.isArray(entry)) {
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
        if (!Array.isArray(entry) && entry && typeof entry === 'object') {
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

function stringInput(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function rawRemotePathInput(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function normalizeStaticRemotePath(value: string, cwd?: string): string | undefined {
  // Every character is significant in a POSIX filename. Reject rather than
  // canonicalize leading/trailing whitespace or quote-like input supplied
  // outside the shell parser.
  if (value !== value.trim()) return undefined;
  if (/^['"]|['"]$/u.test(value)) return undefined;
  const trimmed = value;
  // Remote commands run under POSIX path semantics. A backslash preserved by
  // shell quoting is a literal filename character, never a `/` separator.
  if (trimmed.includes('\\')) return undefined;
  if (!trimmed || hasDynamicOrGlobTargetSyntax(trimmed)) return undefined;
  if (posix.isAbsolute(trimmed)) return posix.normalize(trimmed);
  if (!cwd || !posix.isAbsolute(cwd)) return undefined;
  return posix.resolve(cwd, trimmed);
}

function humanizeRemoteIdentifier(identifier: string): string | undefined {
  const clean = identifier;
  if (!clean || clean === '.' || clean === '..') return undefined;
  if (!/^[A-Za-z0-9._@%+,=~-]+$/.test(clean)) return undefined;
  // Target identifiers participate in authorization. Preserve their literal
  // separators so `orion-agent`, `orion_agent`, and `orion.agent` cannot
  // collapse to the same authority token. Keep only the two historical exact
  // aliases whose objective spelling is intentionally different.
  if (/^pns-gen-worktrees?$/i.test(clean) || /^pnsgen$/i.test(clean)) return 'pns gen';
  if (/^devlogin$/i.test(clean)) return 'dev login';
  return clean;
}

function remoteScopeFromPath(value: string, cwd?: string): string | undefined {
  const normalized = normalizeStaticRemotePath(value, cwd);
  if (!normalized) return undefined;
  const systemdUnit = /^\/etc\/systemd\/system\/([^/]+)\.service$/i.exec(normalized)?.[1];
  if (systemdUnit) return systemdUnit;
  const workspaceMatch = /^\/srv\/workspaces?\/([^/]+)(?:\/(.*))?$/i.exec(normalized);
  if (workspaceMatch?.[1] === '.worktrees') {
    const worktreeIdentifier = workspaceMatch[2]?.split('/')[0];
    return worktreeIdentifier && !worktreeIdentifier.startsWith('.')
      ? humanizeRemoteIdentifier(worktreeIdentifier)
      : undefined;
  }
  // Hidden workspace control directories are never project identities. Only
  // the conventional `.worktrees/<literal-project>` layout above may expose
  // its concrete child as an authorization target.
  if (workspaceMatch?.[1]?.startsWith('.')) return undefined;
  const managedDevProject = /^\/opt\/ia-webdev\/agent-dev\/(?:integration|worktrees)\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/u.exec(normalized)?.[1];
  const identifier = workspaceMatch?.[1]
    ?? managedDevProject
    ?? /^\/srv\/(?:apps|services|sites|www)\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/var\/www\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/opt\/([^/]+)(?:\/|$)/i.exec(normalized)?.[1]
    ?? /^\/srv\/(?!workspaces?(?:\/|$)|apps(?:\/|$)|services(?:\/|$)|sites(?:\/|$)|www(?:\/|$))([^/]+)(?:\/|$)/i.exec(normalized)?.[1];
  return identifier ? humanizeRemoteIdentifier(identifier) : undefined;
}

function pathReferences(value: string): string[] {
  const literalPath = /^(?:\/|\.{1,2}\/|[A-Za-z0-9._@%+,=~-]+\/)[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*$/;
  if (literalPath.test(value)) return [value];
  return uniqueTargets([...value.matchAll(
    /(?:^|[^A-Za-z0-9._@%+,-])((?:\.{1,2}\/|\/)[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*)/g,
  )].map(match => match[1]));
}

function commandFromActionInput(input: Record<string, unknown>): string {
  return [input.command, input.cmd, input.script]
    .find((value): value is string => typeof value === 'string')?.trim() ?? '';
}

function hasUnsupportedRemoteScopeNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasUnsupportedRemoteScopeNode);
  const node = value as Record<string, unknown>;
  if (node.async === true) return true;
  // The bounded remote grammar only reasons about top-level simple commands,
  // lists and logical expressions. Shell compound bodies can mutate the
  // caller's cwd/state while collectSimpleCommands sees only a later command
  // (for example `if ...; then cd ../sibling; fi; touch marker`). Keep every
  // compound/control-flow form fail-closed instead of partially traversing it.
  if ([
    'Case', 'CaseItem', 'CompoundList', 'For', 'Function', 'If', 'Pipeline',
    'Subshell', 'Until', 'While',
  ].includes(String(node.type ?? ''))) return true;
  return Object.values(node).some(hasUnsupportedRemoteScopeNode);
}

function remoteCdTransitionsAreSafelyChained(ast: unknown): boolean {
  const containsCd = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsCd);
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') {
      const name = (node.name as { text?: string } | undefined)?.text;
      const suffix = Array.isArray(node.suffix)
        ? node.suffix.map(item => (item as { text?: string }).text).filter((word): word is string => !!word)
        : [];
      if (name && basename(unwrapCommand([name, ...suffix])[0] ?? '') === 'cd') return true;
    }
    return Object.values(node).some(containsCd);
  };
  if (!containsCd(ast)) return true;
  if (!ast || typeof ast !== 'object' || Array.isArray(ast)) return false;
  const script = ast as { type?: string; commands?: unknown[] };
  if (script.type !== 'Script' || script.commands?.length !== 1) return false;

  const flattenAndChain = (value: unknown): Array<Record<string, unknown>> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const node = value as Record<string, unknown>;
    if (node.type === 'Command') return [node];
    if (node.type !== 'LogicalExpression' || node.op !== 'and') return undefined;
    const left = flattenAndChain(node.left);
    const right = flattenAndChain(node.right);
    return left && right ? [...left, ...right] : undefined;
  };
  const chain = flattenAndChain(script.commands[0]);
  if (!chain || chain.length < 2) return false;
  return chain.every((node, index) => {
    const name = (node.name as { text?: string } | undefined)?.text;
    const suffix = Array.isArray(node.suffix)
      ? node.suffix.map(item => (item as { text?: string }).text).filter((word): word is string => !!word)
      : [];
    const command = name ? unwrapCommand([name, ...suffix]) : [];
    return basename(command[0] ?? '') !== 'cd' || index < chain.length - 1;
  });
}

function hasDynamicShellExpansion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasDynamicShellExpansion);
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.expansion) && node.expansion.length > 0) return true;
  return Object.values(node).some(hasDynamicShellExpansion);
}

function hasUnsafeRemoteInvocationMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasUnsafeRemoteInvocationMetadata);
  const node = value as Record<string, unknown>;
  if (node.type === 'Command') {
    // Shell assignments and `env` can transparently retarget Git, Docker,
    // interpreters and other project commands. The narrow remote recovery
    // cannot prove their scope, so never discard them while unwrapping.
    if (Array.isArray(node.prefix) && node.prefix.length > 0) return true;
    const name = node.name as { text?: string } | undefined;
    const executable = basename(name?.text ?? '');
    const suffix = Array.isArray(node.suffix)
      ? node.suffix.map(item => (item as { text?: string }).text).filter((item): item is string => !!item)
      : [];
    if (executable === 'env') return true;
    if (executable === 'time' && suffix[0]?.startsWith('-')) {
      return true;
    }
    if (executable === 'sudo' && suffix[0]?.startsWith('-')) {
      return true;
    }
  }
  return Object.values(node).some(hasUnsafeRemoteInvocationMetadata);
}

const PROJECT_SCOPED_REMOTE_EXECUTABLES = new Set([
  // File mutations cannot safely inherit a lexical cwd scope: any component
  // may be a symlink to another project, and a realpath preflight would be
  // TOCTOU. Keep only clients with dedicated destination classifiers here.
  'service', 'systemctl',
]);

const REMOTE_FILE_MUTATOR_EXECUTABLES = new Set([
  'chmod', 'chown', 'cp', 'install', 'ln', 'mkdir', 'mv', 'rm', 'rmdir',
  'touch', 'truncate', 'unlink',
]);

const REMOTE_FILESYSTEM_MUTATION_EXECUTABLES = new Set([
  ...REMOTE_FILE_MUTATOR_EXECUTABLES,
  'printf', 'sed',
]);

function hasUnsafeRemoteWrapperChain(words: string[]): boolean {
  let current = [...words];
  for (let pass = 0; pass < 8 && current.length > 0; pass += 1) {
    const rawExecutable = current[0]!;
    if (rawExecutable.includes('/') || rawExecutable.includes('\\')) return true;
    const executable = basename(rawExecutable);
    if (executable === 'env' || executable === 'nohup') return true;
    if (executable === 'command' || executable === 'sudo'
      || executable === 'nice' || executable === 'time') {
      if (!current[1] || current[1]!.startsWith('-')) return true;
      current = current.slice(1);
      continue;
    }
    if (executable === 'timeout') {
      const duration = current[1];
      if (!duration || duration.startsWith('-')
        || !/^\d+(?:\.\d+)?(?:[smhd])?$/.test(duration)
        || !current[2]) return true;
      current = current.slice(2);
      continue;
    }
    return false;
  }
  return true;
}
const STATIC_REMOTE_FILE_OPERAND_PATTERN = /^(?:(?:\.{1,2}\/|\/)?[A-Za-z0-9._@%+,=~-]+(?:\/[A-Za-z0-9._@%+,=~-]+)*)$/;

const PACKAGE_MANAGER_EXECUTABLES = new Set(['bun', 'npm', 'npx', 'pnpm', 'yarn']);
const LOCAL_PACKAGE_SCRIPT = /^(?:build|check|dev|electron(?::|-)|format|generate|lint|test|typecheck|validate|verify)(?:$|[:-])/i;
const BOUNDED_DEPLOYMENT_SCRIPT = /^deploy(?::[a-z0-9_-]+)?$/i;
const EXTERNAL_PACKAGE_OPERATIONS = new Set([
  'access', 'deprecate', 'dist-tag', 'dlx', 'exec', 'login', 'logout', 'owner',
  'publish', 'unpublish', 'x',
]);

const PACKAGE_MANAGER_OPTIONS_WITH_VALUES = new Set([
  '--cache', '--config', '--cwd', '--dir', '--filter', '--global-dir', '--globalconfig',
  '--loglevel', '--prefix', '--registry', '--store-dir', '--userconfig', '--workspace',
  '-C', '-F', '-w',
]);

function packageManagerActionIndex(words: string[]): number {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--') return index + 1 < words.length ? index + 1 : -1;
    if (!word.startsWith('-')) return index;
    const optionName = word.split('=', 1)[0]!;
    if (!word.includes('=') && PACKAGE_MANAGER_OPTIONS_WITH_VALUES.has(optionName)) index += 1;
  }
  return -1;
}

function isBoundedProjectPackageCommand(words: string[]): boolean | undefined {
  const executable = basename(words[0] ?? '');
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return undefined;
  if (executable === 'npx') return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = operationIndex >= 0 ? words[operationIndex]?.toLowerCase() : undefined;
  if (!operation || EXTERNAL_PACKAGE_OPERATIONS.has(operation)) return false;
  if (operation === 'run') {
    const script = words.slice(operationIndex + 1).find(word => !word.startsWith('-'));
    return !!script && (LOCAL_PACKAGE_SCRIPT.test(script) || BOUNDED_DEPLOYMENT_SCRIPT.test(script));
  }
  if (LOCAL_PACKAGE_SCRIPT.test(operation) || BOUNDED_DEPLOYMENT_SCRIPT.test(operation)) return true;
  return new Set(['add', 'ci', 'install', 'link', 'remove', 'uninstall', 'update']).has(operation);
}

function packageManagerExternalOperation(
  words: string[],
): SensitiveExternalActionCategory | undefined {
  const executable = basename(words[0] ?? '');
  if (executable === 'npx' || executable === 'bunx') return 'external_mutation';
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return undefined;
  if (isBoundedProjectPackageCommand(words) === true) return undefined;
  // Package CLIs accept global options (with separate values) before the
  // operation and several unambiguous abbreviations. Scan the complete token
  // stream conservatively instead of letting an option value impersonate the
  // action position.
  const tokens = words.slice(1).map(word => word.toLowerCase());
  if (tokens.some(token => ['pub', 'publish', 'unpub', 'unpublish'].includes(token))) {
    return 'external_publication';
  }
  return 'external_mutation';
}

const CONTAINER_MULTI_TARGET_COMMANDS = new Set([
  'kill', 'pause', 'restart', 'rm', 'start', 'stop', 'unpause', 'update', 'wait',
]);

const CONTAINER_OPTIONS_WITH_VALUES = new Set([
  '--cidfile', '--detach-keys', '--env', '--env-file', '--filter', '--format',
  '--signal', '--time', '--user', '--workdir', '-e', '-t', '-u', '-w',
]);

const BOUNDED_COMPOSE_MUTATIONS = new Set([
  'build', 'create', 'down', 'kill', 'pause', 'pull', 'restart', 'rm', 'start',
  'stop', 'unpause', 'up',
]);

const BOUNDED_COMPOSE_ACTION_OPTIONS = new Map<string, ReadonlySet<string>>([
  // Keep the compatibility grammar deliberately small. These flags neither
  // retarget the compose project/daemon nor publish an image. Unknown flags
  // (including build --push and builder selections) remain unresolved.
  ['up', new Set(['-d', '--detach', '--no-build', '--no-deps', '--force-recreate', '--remove-orphans', '--wait'])],
  ['down', new Set(['--remove-orphans'])],
  ['restart', new Set([])],
  ['start', new Set([])],
  ['stop', new Set([])],
  ['pause', new Set([])],
  ['unpause', new Set([])],
  ['kill', new Set([])],
  ['rm', new Set(['-f', '--force', '-s', '--stop'])],
  ['create', new Set(['--no-build', '--no-recreate', '--force-recreate'])],
  ['build', new Set([])],
  ['pull', new Set([])],
]);

/**
 * Extract container identities from mutating Docker/Podman operations. A
 * project cwd is not authority over an adjacent container, so an unsupported
 * or dynamic form deliberately becomes unresolved.
 */
function containerMutationScopeTargets(words: string[], cwd?: string): string[] | undefined {
  const executable = basename(words[0] ?? '');
  if (executable !== 'docker' && executable !== 'podman') return undefined;
  // Remote recovery admits only the default local engine. Global CLI options
  // may select another daemon, config, connection or storage root.
  if (words[1]?.startsWith('-')) return [UNRESOLVED_REMOTE_SCOPE];
  const retargeted = executable === 'docker'
    ? words.slice(1).some(word => /^(?:-H(?:.+)?|--(?:h|ho|hos|host|c|co|con|cont|conte|contex|context)(?:=|$))/.test(word))
    : words.slice(1).some(word => /^(?:-c(?:.+)?|--(?:r|re|rem|remo|remot|remote|u|ur|url|c|co|con|conn|conne|connec|connect|connecti|connectio|connection)(?:=|$))/.test(word));
  if (retargeted) return [UNRESOLVED_REMOTE_SCOPE];
  const supportedSubcommands = new Set([
    ...CONTAINER_MULTI_TARGET_COMMANDS,
    'cp', 'rename',
  ]);
  // Global options were rejected above, therefore the first token after the
  // executable must itself be the supported subcommand. Never scan through an
  // opaque nested command (for example `docker exec ... rm`) and mistake it
  // for the outer operation.
  const subcommandIndex = supportedSubcommands.has(words[1] ?? '') || words[1] === 'compose'
    ? 1
    : -1;
  if (subcommandIndex < 0) return [UNRESOLVED_REMOTE_SCOPE];
  const subcommand = words[subcommandIndex]!;
  if (subcommand === 'compose') {
    // Compose scope flags precede the action and can point at another project
    // even while cwd still names Orion. No pre-action option is needed by the
    // bounded live mutation grammar.
    const composeAction = words[subcommandIndex + 1]?.toLowerCase();
    if (!composeAction || composeAction.startsWith('-')
      || !BOUNDED_COMPOSE_MUTATIONS.has(composeAction)) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    const allowedOptions = BOUNDED_COMPOSE_ACTION_OPTIONS.get(composeAction);
    if (!allowedOptions || words.slice(subcommandIndex + 2).some(word =>
      word.startsWith('-') && !allowedOptions.has(word)
    )) return [UNRESOLVED_REMOTE_SCOPE];
    const services = words.slice(subcommandIndex + 2)
      .filter(word => !word.startsWith('-'));
    if (services.some(hasDynamicOrGlobTargetSyntax)) return [UNRESOLVED_REMOTE_SCOPE];
    // `down` is project-wide and has no service operand. Every other bounded
    // action may name services, which are part of the exact authorization
    // target rather than being allowed to disappear behind the project cwd.
    if (composeAction === 'down' && services.length > 0) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    return uniqueTargets(services);
  }

  const positional: string[] = [];
  for (let index = subcommandIndex + 1; index < words.length; index += 1) {
    const word = words[index]!;
    const optionName = word.split('=', 1)[0]!;
    if (word.startsWith('-')) {
      if (!word.includes('=') && CONTAINER_OPTIONS_WITH_VALUES.has(optionName)) index += 1;
      continue;
    }
    positional.push(word);
    if (subcommand === 'exec') break;
  }

  let identifiers: string[];
  if (subcommand === 'cp') {
    identifiers = [];
    for (const value of positional) {
      if (hasDynamicOrGlobTargetSyntax(value)) return [UNRESOLVED_REMOTE_SCOPE];
      const containerEndpoint = /^([^/:]+):(.+)$/.exec(value);
      if (containerEndpoint) {
        identifiers.push(containerEndpoint[1]!);
        continue;
      }
      const hostPath = normalizeStaticRemotePath(value, cwd);
      const hostScope = hostPath ? remoteScopeFromPath(hostPath) : undefined;
      identifiers.push(hostScope ?? UNRESOLVED_REMOTE_SCOPE);
    }
  } else if (subcommand === 'rename') {
    identifiers = positional.slice(0, 2);
  } else {
    identifiers = positional;
  }
  if (identifiers.length === 0 || identifiers.some(hasDynamicOrGlobTargetSyntax)) {
    return [UNRESOLVED_REMOTE_SCOPE];
  }
  return uniqueTargets(identifiers);
}

/** Extract only sed's in-place file operands. Programs may themselves contain
 * slash-delimited paths, but those strings are replacement data, not remote
 * scope. Unsupported/operand-free forms stay unresolved. */
function sedInPlaceMutationFileOperands(words: string[]): string[] | undefined {
  if (basename(words[0] ?? '') !== 'sed') return undefined;
  let inPlace = false;
  let hasProgram = false;
  let optionsEnded = false;
  const programs: string[] = [];
  const files: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (word === '-i' || word === '--in-place')) {
      inPlace = true;
      if (words[index + 1] === '') index += 1; // BSD `sed -i '' ...`
      continue;
    }
    if (!optionsEnded && (/^-i.+/.test(word) || /^--in-place=/.test(word))) {
      const backupSuffix = word.startsWith('--in-place=')
        ? word.slice('--in-place='.length)
        : word.slice(2);
      if (backupSuffix.includes('/') || hasDynamicOrGlobTargetSyntax(backupSuffix)) return [];
      inPlace = true;
      continue;
    }
    if (!optionsEnded && ['-n', '--quiet', '--silent'].includes(word)) continue;
    if (!optionsEnded && ['-f', '--file'].includes(word)) return inPlace ? [] : undefined;
    if (!optionsEnded && ['-e', '--expression'].includes(word)) {
      if (typeof words[index + 1] !== 'string') return inPlace ? [] : undefined;
      hasProgram = true;
      programs.push(words[index + 1]!);
      index += 1;
      continue;
    }
    if (!optionsEnded && /^(?:-f.+|--file=)/.test(word)) return inPlace ? [] : undefined;
    if (!optionsEnded && /^(?:-e|--expression=).+/.test(word)) {
      hasProgram = true;
      programs.push(word.startsWith('-e') ? word.slice(2) : word.slice('--expression='.length));
      continue;
    }
    if (!optionsEnded && word.startsWith('-')) return inPlace ? [] : undefined;
    if (!hasProgram) {
      hasProgram = true;
      programs.push(word);
      continue;
    }
    files.push(word);
  }
  if (!inPlace) return undefined;
  const boundedSubstitution = (program: string): boolean => {
    if (!program || program.length > 4_096 || /[\r\n]/.test(program)) return false;
    return program.split(';').every(rawExpression => {
      const expression = rawExpression.trim();
      if (expression[0] !== 's') return false;
      const delimiter = expression[1];
      if (!delimiter || /[A-Za-z0-9\\\s]/.test(delimiter)) return false;
      let separators = 0;
      let escaped = false;
      let finalSeparator = -1;
      for (let index = 2; index < expression.length; index += 1) {
        const character = expression[index]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character !== delimiter) continue;
        separators += 1;
        finalSeparator = index;
      }
      if (separators !== 2 || finalSeparator < 0) return false;
      return /^[gIp0-9]*$/.test(expression.slice(finalSeparator + 1));
    });
  };
  return files.length > 0 && programs.length > 0 && programs.every(boundedSubstitution)
    ? files
    : [];
}

function remoteServiceMutationScopeTargets(
  words: string[],
  companionServiceTargets: readonly string[] = [],
): string[] | undefined {
  const executable = basename(words[0] ?? '');
  if (executable === 'systemctl') {
    if (words[1]?.startsWith('-')) return [UNRESOLVED_REMOTE_SCOPE];
    if (words.slice(1).some(word => /^(?:-[HM](?:.+)?|--(?:h|ho|hos|host|m|ma|mac|mach|machi|machin|machine|r|ro|roo|root|i|im|ima|imag|image)(?:=|$))/.test(word))) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    // Manager selectors are meaningful even after the action (`restart
    // --user unit`). Never let positional parsing silently discard a switch
    // from the system manager authorized by the objective to another scope.
    if (words.slice(1).some(word => /^--(?:u|us|use|user|g|gl|glo|glob|globa|global|s|sy|sys|syst|syste|system)(?:=|$)/.test(word))) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    const actionIndex = firstCliActionIndex(
      words, 1, new Set(['-H', '--host', '-M', '--machine', '--root', '--image']),
    );
    const action = words[actionIndex]?.toLowerCase();
    // daemon-reload changes systemd's global manager state and names no unit.
    // It is target-neutral only inside the same static composite as an exact
    // unit mutation/file installation; standalone reloads remain unresolved.
    if (action === 'daemon-reload') {
      return companionServiceTargets.length > 0 ? [] : [UNRESOLVED_REMOTE_SCOPE];
    }
    if (!action || !new Set([
      'disable', 'enable', 'mask', 'reenable', 'reload', 'reload-or-restart',
      'reload-or-try-restart', 'restart', 'start', 'stop', 'try-restart', 'unmask',
    ]).has(action)) return [UNRESOLVED_REMOTE_SCOPE];
    const units = positionalAfter(words, actionIndex).map(unit => unit.replace(/\.service$/i, ''));
    if (units.length === 0 || units.some(hasDynamicOrGlobTargetSyntax)) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    return uniqueTargets(units);
  }
  if (executable === 'service') {
    const unit = words[1];
    const action = words[2]?.toLowerCase();
    if (!unit || !['reload', 'restart', 'start', 'stop'].includes(action ?? '')
      || hasDynamicOrGlobTargetSyntax(unit)) return [UNRESOLVED_REMOTE_SCOPE];
    return uniqueTargets([unit.replace(/\.service$/i, '')]);
  }
  return undefined;
}

const GNU_TARGET_DIRECTORY_MUTATORS = new Set(['cp', 'install', 'ln', 'mv']);

/**
 * GNU file mutators accept a destination through `-t DIR`, `-tDIR`, and
 * `--target-directory=DIR`. The attached short form is invisible to the
 * generic path scanner (`-t/tmp`), so expose it as a real scope operand.
 */
function fileMutationTargetDirectoryOperands(words: string[]): string[] | undefined {
  if (!GNU_TARGET_DIRECTORY_MUTATORS.has(basename(words[0] ?? ''))) return undefined;
  const targets: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (/^-[A-Za-z]*t$/.test(word) || word === '--target-directory') {
      const target = words[index + 1];
      if (!target || target.startsWith('-')) return [];
      targets.push(target);
      index += 1;
      continue;
    }
    const attachedShort = /^-[A-Za-z]*t=?(.+)$/.exec(word)?.[1];
    if (attachedShort) {
      targets.push(attachedShort);
      continue;
    }
    const attachedLong = /^--target-directory=(.+)$/.exec(word)?.[1];
    if (attachedLong) targets.push(attachedLong);
  }
  return targets;
}

/** GNU install can execute an arbitrary helper through --strip-program. Keep
 * the remotely-authorizable form to the one needed by the Orion deployment:
 * an optional literal mode followed by exactly one source and destination. */
function installMutationFileOperands(words: string[]): string[] | undefined {
  if (words[0] !== 'install') return undefined;
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  let options = true;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && (word === '-m' || word === '--mode')) {
      const mode = words[index + 1];
      if (!mode || !/^[0-7]{3,4}$/.test(mode)) return [];
      index += 1;
      continue;
    }
    if (options && /^-m[0-7]{3,4}$/.test(word)) continue;
    if (options && /^--mode=[0-7]{3,4}$/.test(word)) continue;
    if (options && (word === '-t' || word === '--target-directory')) {
      const target = words[index + 1];
      if (!target || target.startsWith('-') || targetDirectory) return [];
      targetDirectory = target;
      index += 1;
      continue;
    }
    if (options && /^-t(.+)$/.test(word)) {
      if (targetDirectory) return [];
      targetDirectory = word.slice(2);
      continue;
    }
    if (options && /^--target-directory=(.+)$/.test(word)) {
      if (targetDirectory) return [];
      targetDirectory = word.slice('--target-directory='.length);
      continue;
    }
    if (options && word.startsWith('-')) return [];
    operands.push(word);
  }
  if (targetDirectory) return operands.length === 1 ? [...operands, targetDirectory] : [];
  return operands.length === 2 ? operands : [];
}

const SYSTEMD_UNIT_FILE_MUTATORS = new Set(['cp', 'install', 'ln', 'mv', 'tee']);

function exactCompanionRemoteServiceTargets(commands: string[][]): string[] {
  const targets: string[] = [];
  for (const rawWords of commands) {
    const words = unwrapCommand(rawWords);
    if (words.length === 0) continue;
    const serviceTargets = remoteServiceMutationScopeTargets(words);
    if (serviceTargets) {
      targets.push(...serviceTargets.filter(target => target !== UNRESOLVED_REMOTE_SCOPE));
    }
    if (!SYSTEMD_UNIT_FILE_MUTATORS.has(basename(words[0] ?? ''))) continue;
    for (const word of words.slice(1)) {
      for (const reference of pathReferences(word)) {
        const normalized = normalizeStaticRemotePath(reference);
        const unit = normalized
          ? /^\/etc\/systemd\/system\/([^/]+)\.service$/i.exec(normalized)?.[1]
          : undefined;
        if (unit && !hasDynamicOrGlobTargetSyntax(unit)) targets.push(unit);
      }
    }
  }
  return uniqueTargets(targets);
}

function extractRemoteCommandScopeTargets(input: Record<string, unknown>): string[] {
  const cwd = rawRemotePathInput(input, ['cwd', 'workingDirectory', 'working_directory']);
  let effectiveCwd = cwd ? normalizeStaticRemotePath(cwd) : undefined;
  const remoteEndpoint = stringInput(input, ['server', 'host', 'hostname']);
  const remoteEndpointTarget = remoteEndpoint && remoteEndpoint.length <= 256
    && !hasDynamicOrGlobTargetSyntax(remoteEndpoint)
    && /^[A-Za-z0-9._@:-]+(?:\s+[A-Za-z0-9._@:-]+)*$/.test(remoteEndpoint)
    ? remoteEndpoint
    : undefined;
  const bindRemoteEndpoint = (targets: string[]): string[] => {
    const scoped = uniqueTargets(targets);
    return remoteEndpointTarget
      ? uniqueTargets([remoteEndpointTarget, ...scoped])
      : uniqueTargets([UNRESOLVED_EXTERNAL_TARGET, ...scoped, UNRESOLVED_REMOTE_SCOPE]);
  };
  const command = commandFromActionInput(input);
  try {
    const ast = bashParser(command);
    if (hasUnsupportedRemoteScopeNode(ast) || hasDynamicShellExpansion(ast)
      || hasUnsafeRemoteInvocationMetadata(ast)
      || !remoteCdTransitionsAreSafelyChained(ast)) {
      return bindRemoteEndpoint([
        effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined,
        UNRESOLVED_REMOTE_SCOPE,
      ].filter((target): target is string => !!target));
    }
  } catch {
    return command ? [UNRESOLVED_REMOTE_SCOPE] : extractInputTargets(input);
  }
  const commands = parseSimpleCommands(command);
  if (command && commands.length === 0) return [UNRESOLVED_REMOTE_SCOPE];
  const companionServiceTargets = exactCompanionRemoteServiceTargets(commands);

  const mutationTargets: string[] = [];
  let sawMutationCommand = false;
  let unresolvedWorkingDirectory = false;
  for (const rawWords of commands) {
    // Validate the process that performs any wrapper semantics before
    // `unwrapCommand` removes it. A project-controlled lookalike named
    // `command`, `sudo`, `time`, etc. must never inherit Orion authority.
    if (hasUnsafeRemoteWrapperChain(rawWords)) {
      sawMutationCommand = true;
      mutationTargets.push(
        effectiveCwd ? remoteScopeFromPath(effectiveCwd) ?? UNRESOLVED_REMOTE_SCOPE : UNRESOLVED_REMOTE_SCOPE,
        UNRESOLVED_REMOTE_SCOPE,
      );
      continue;
    }
    const words = unwrapCommand(rawWords);
    if (words.length === 0) continue;
    const executable = basename(words[0]!);
    // Do not authorize a project-controlled lookalike merely because its
    // basename is `touch`, `systemctl`, `docker`, etc. The bounded grammar
    // invokes PATH-resolved bare utilities only; slash-bearing executables are
    // outside this compatibility shim.
    if (words[0] !== executable) {
      sawMutationCommand = true;
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }
    if (executable === 'cd') {
      const destination = words.find((word, index) => index > 0 && !word.startsWith('-'));
      if (!destination || destination === '-' || /[$`~]/.test(destination)
        || /(?:\|\||(?<!\|)\|(?!\|))/.test(command)) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
        continue;
      }
      const resolved = normalizeStaticRemotePath(destination, effectiveCwd);
      if (!resolved) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
        continue;
      }
      effectiveCwd = resolved;
      if (!remoteScopeFromPath(effectiveCwd)) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
      }
      continue;
    }

    const serialized = words.join(' ');
    if (isProvablyReadOnlyShellCommand(serialized)
      || isReadOnlyRegisteredShellObservation(serialized)) continue;
    sawMutationCommand = true;
    // Once a preceding `cd` has escaped (or could not prove) the project
    // scope, later relative operands must not manufacture a new target from
    // the escaped directory basename. Shell `cd` persists across `;`/`&&`.
    if (unresolvedWorkingDirectory) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }

    const cwdTarget = effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined;

    // Lexical path resolution cannot prove a mutation remains in the named
    // project because any cwd/operand component may be a symlink. Likewise a
    // shell redirection is an independent filesystem mutation. These commands
    // remain available through the ordinary explicit host prompt, but never
    // receive exact-scope/allow-in-execute authority from this compatibility.
    const unconfinedFilesystemMutation = REMOTE_FILESYSTEM_MUTATION_EXECUTABLES.has(executable)
      || words.some(word => /^(?:>|>>|<|<>|>&|<&)$/.test(word));

    // Curl and Wget load user/project configuration and expose multiple
    // retargeting grammars (config files, redirects, proxy/resolve, multiple
    // URLs, file-backed bodies). No remote HTTP mutation receives exact-scope
    // or allow-in-execute authority; it remains available behind a generic
    // explicit host prompt.
    if (['curl', 'wget'].includes(executable)) {
      mutationTargets.push(...uniqueTargets([cwdTarget, UNRESOLVED_REMOTE_SCOPE]));
      continue;
    }

    // Docker and Podman read ambient contexts/configuration that can redirect
    // even a flag-free command to another daemon. Preserve parsed identities
    // for an informative prompt, but never claim an exact engine/project.
    if (['docker', 'podman'].includes(executable)) {
      const parsedTargets = containerMutationScopeTargets(words, effectiveCwd) ?? [];
      mutationTargets.push(...uniqueTargets([
        cwdTarget, ...parsedTargets, UNRESOLVED_REMOTE_SCOPE,
      ]));
      continue;
    }

    const containerTargets = containerMutationScopeTargets(words, effectiveCwd);
    if (containerTargets) {
      mutationTargets.push(...uniqueTargets([cwdTarget, ...containerTargets]));
      continue;
    }
    const serviceTargets = remoteServiceMutationScopeTargets(words, companionServiceTargets);
    if (serviceTargets) {
      mutationTargets.push(...uniqueTargets([cwdTarget, ...serviceTargets]));
      continue;
    }
    const boundedPackageCommand = isBoundedProjectPackageCommand(words);
    if (boundedPackageCommand !== undefined) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }
    // Only a closed local-project grammar may inherit authority from cwd.
    // Unknown clients can address a cluster, cloud account, database, queue,
    // or another host without exposing that destination as a filesystem path.
    if (!unconfinedFilesystemMutation
      && boundedPackageCommand !== true
      && !PROJECT_SCOPED_REMOTE_EXECUTABLES.has(executable)) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }

    const explicitTargets: string[] = [];
    const sedFileOperands = sedInPlaceMutationFileOperands(words);
    const installFileOperands = installMutationFileOperands(words);
    const targetDirectoryOperands = fileMutationTargetDirectoryOperands(words);
    const targetWords = sedFileOperands
      ?? installFileOperands
      ?? [...words.slice(1), ...(targetDirectoryOperands ?? [])];
    if (sedFileOperands?.length === 0) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    if (installFileOperands?.length === 0) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    if (targetDirectoryOperands?.length === 0 && words.slice(1).some(word =>
      /^-[A-Za-z]*t$/.test(word) || word === '--target-directory'
    )) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    for (let wordIndex = 0; wordIndex < targetWords.length; wordIndex += 1) {
      const word = targetWords[wordIndex]!;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) continue;
      const previousWord = targetWords[wordIndex - 1];
      const isRedirectTarget = previousWord !== undefined
        && /^(?:>|>>|<|<>|>&|<&)$/.test(previousWord);
      const isFileScopeOperand = !!sedFileOperands
        || REMOTE_FILE_MUTATOR_EXECUTABLES.has(executable)
        || isRedirectTarget;
      // A wildcard, home expansion, bare traversal/root operand, or malformed
      // path cannot safely inherit the cwd project. In particular, `..`, `/`
      // and glob operands used to disappear from pathReferences and silently
      // fall back to the authorized project scope.
      if (isFileScopeOperand && (hasDynamicOrGlobTargetSyntax(word)
        || /^(?:\.{1,2}\/*|\/+)$/.test(word))) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      if (isFileScopeOperand && word.startsWith('-')) continue;
      // A file mutator operand is one shell word and must be validated as one
      // complete literal path. Extracting a valid-looking prefix from
      // `/srv/workspace/orion evil` silently authorizes a different sibling.
      if (isFileScopeOperand && !STATIC_REMOTE_FILE_OPERAND_PATTERN.test(word)) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      const references = isFileScopeOperand ? [word] : pathReferences(word);
      if (isFileScopeOperand && !sedFileOperands && references.length === 0
        && (word.startsWith('/') || word.startsWith('./') || word.startsWith('../'))) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      for (const reference of references) {
        const resolved = normalizeStaticRemotePath(reference, effectiveCwd);
        if (!resolved) {
          explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
          continue;
        }
        const target = remoteScopeFromPath(resolved);
        explicitTargets.push(target ?? UNRESOLVED_REMOTE_SCOPE);
      }
    }
    if (explicitTargets.length > 0) {
      mutationTargets.push(...uniqueTargets([
        ...explicitTargets,
        unconfinedFilesystemMutation ? UNRESOLVED_REMOTE_SCOPE : undefined,
      ]));
      continue;
    }
    if (cwdTarget) mutationTargets.push(...uniqueTargets([
      cwdTarget,
      unconfinedFilesystemMutation ? UNRESOLVED_REMOTE_SCOPE : undefined,
    ]));
  }

  const scoped = uniqueTargets(mutationTargets);
  if (scoped.length > 0) return bindRemoteEndpoint(scoped);
  if (sawMutationCommand) return [UNRESOLVED_REMOTE_SCOPE];
  const cwdTarget = effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined;
  return cwdTarget
    ? bindRemoteEndpoint([cwdTarget])
    : command ? [UNRESOLVED_REMOTE_SCOPE] : extractInputTargets(input);
}

/** Resolve a transfer destination before deriving its concrete project. */
function extractRemoteTransferScopeTargets(input: Record<string, unknown>): string[] {
  const endpoint = stringInput(input, ['server', 'host', 'hostname']);
  const literalEndpoint = endpoint && endpoint.length <= 256
    && /^[A-Za-z0-9._@:-]+$/.test(endpoint) ? endpoint : undefined;
  const cwd = rawRemotePathInput(input, ['cwd', 'workingDirectory', 'working_directory']);
  const remotePath = rawRemotePathInput(input, [
    'remotePath', 'remote_path', 'destination', 'targetPath', 'target_path',
  ]);
  const normalizedCwd = cwd ? normalizeStaticRemotePath(cwd) : undefined;
  const resolvedPath = remotePath
    ? normalizeStaticRemotePath(remotePath, normalizedCwd)
    : undefined;
  const lexicalScope = resolvedPath ? remoteScopeFromPath(resolvedPath) : undefined;
  // Upload/copy/write destinations can traverse symlinks and the transport
  // endpoint is an independent authority boundary. Without an atomic remote
  // confinement primitive, the lexical scope is display/prompt context only.
  return uniqueTargets([literalEndpoint, lexicalScope, UNRESOLVED_REMOTE_SCOPE]);
}

export function isSensitiveRemoteTransferSource(input: Record<string, unknown>): boolean {
  const source = rawRemotePathInput(input, [
    'localPath', 'local_path', 'source', 'sourcePath', 'source_path',
  ]);
  if (!source) return false;
  const normalized = source.replace(/\\/gu, '/');
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|(?:auth|token)(?:\.[^/]*)?|[^/]*(?:api[_-]?key|credential|private[_-]?key|secret|password)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(normalized)
    || /(?:^|\/)(?:\.secrets?|\.ssh|\.aws|credentials?|secrets?|\.config\/gcloud)(?:\/|$)/iu.test(normalized)
    || /(?:^|\/)\.docker\/config\.json$/iu.test(normalized);
}

function remoteTransferPermissionPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const source = safePermissionPromptValue(
    rawRemotePathInput(input, ['localPath', 'local_path', 'source', 'sourcePath', 'source_path']),
    '[unresolved source]',
  );
  const endpoint = safePermissionPromptValue(
    stringInput(input, ['server', 'host', 'hostname']), '[unresolved host]',
  );
  const destination = safePermissionPromptValue(
    rawRemotePathInput(input, ['remotePath', 'remote_path', 'destination', 'targetPath', 'target_path']),
    '[unresolved destination]',
  );
  return `${toolName} source=${JSON.stringify(source)} destination=${JSON.stringify(`${endpoint}:${destination}`)}`;
}

function collectSimpleCommands(node: AstNode | undefined, result: string[][]): void {
  if (!node) return;
  if (node.type === 'Command') {
    const words: string[] = [];
    if (node.name?.text) words.push(node.name.text);
    for (const suffix of node.suffix ?? []) {
      if (suffix.type === 'Word' && typeof suffix.text === 'string') words.push(suffix.text);
      if (suffix.type === 'Redirect' && typeof suffix.file?.text === 'string') {
        words.push(suffix.op?.text ?? '>');
        words.push(suffix.file.text);
      }
    }
    if (words.length > 0) result.push(words);
    for (const suffix of node.suffix ?? []) {
      for (const expansion of suffix.expansion ?? []) {
        if (expansion && typeof expansion === 'object') {
          collectSimpleCommands((expansion as { commandAST?: AstNode }).commandAST, result);
        }
      }
    }
    return;
  }
  if (node.left) collectSimpleCommands(node.left, result);
  if (node.right) collectSimpleCommands(node.right, result);
  if (node.list) collectSimpleCommands(node.list, result);
  for (const command of node.commands ?? []) collectSimpleCommands(command, result);
}

function parseSimpleCommands(command: string): string[][] {
  try {
    const ast = bashParser(command) as AstNode;
    const commands: string[][] = [];
    collectSimpleCommands(ast, commands);
    return commands;
  } catch {
    return [];
  }
}

function unwrapCommand(words: string[]): string[] {
  let current = [...words];
  for (let pass = 0; pass < 8 && current.length > 0; pass++) {
    const command = basename(current[0]!);
    if (command === 'env') {
      let index = 1;
      while (index < current.length && (current[index]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[index]!))) index += 1;
      current = current.slice(index);
      continue;
    }
    if (command === 'sudo') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-u', '--user', '-g', '--group', '-h', '--host'].includes(option) && index < current.length) index += 1;
      }
      current = current.slice(index);
      continue;
    }
    if (command === 'command' || command === 'nohup') {
      current = current.slice(1);
      continue;
    }
    if (command === 'timeout') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-k', '--kill-after', '-s', '--signal'].includes(option)) index += 1;
      }
      // The first positional is the bounded duration; the next is the real command.
      if (index < current.length) index += 1;
      current = current.slice(index);
      continue;
    }
    if (command === 'nice') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (option === '-n' || option === '--adjustment') index += 1;
      }
      current = current.slice(index);
      continue;
    }
    if (command === 'time') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-f', '--format', '-o', '--output'].includes(option)) index += 1;
      }
      current = current.slice(index);
      continue;
    }
    break;
  }
  return current;
}

function optionValue(words: string[], names: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const equalsName = names.find(name => word.startsWith(`${name}=`));
    if (equalsName) return word.slice(equalsName.length + 1);
    if (names.includes(word) && typeof words[index + 1] === 'string') return words[index + 1];
  }
  return undefined;
}

function firstCliActionIndex(
  words: string[],
  start: number,
  optionsWithValues: ReadonlySet<string> = new Set(),
): number {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return index;
  }
  return -1;
}

const BOUNDED_IMPLEMENTATION_READ_EXECUTABLES = new Set([
  ':', '[', 'basename', 'cat', 'cut', 'date', 'df', 'dirname', 'du', 'echo',
  'file', 'find', 'grep', 'head', 'jq', 'ls', 'printf', 'pwd', 'readlink', 'realpath',
  'rg', 'sort', 'stat', 'tail', 'test', 'tr', 'true', 'false', 'uniq', 'wc',
]);
const BOUNDED_IMPLEMENTATION_GIT_ACTIONS = new Set([
  'add', 'branch', 'commit', 'diff', 'fetch', 'log', 'ls-files',
  'ls-tree', 'push', 'remote', 'rev-parse', 'show', 'status',
]);
const BOUNDED_IMPLEMENTATION_COMPOSE_ACTIONS = new Set([
  'build', 'logs', 'ps', 'pull', 'restart', 'up',
]);
const BOUNDED_IMPLEMENTATION_FILE_MUTATORS = new Set([
  'chmod', 'cp', 'mkdir', 'mv', 'rm', 'rmdir', 'touch',
]);

function boundedImplementationSensitiveControlPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const base = posix.basename(normalized);
  return /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|deno\.jsonc?)$/u.test(normalized)
    || /(?:^|\/)(?:(?:docker-)?compose(?:[._-][^/]*)?\.ya?ml|dockerfile(?:[._-][^/]*)?)$/u.test(normalized)
    || /(?:^|\/)(?:procfile|makefile|jenkinsfile|\.gitlab-ci\.ya?ml|taskfile\.ya?ml)$/u.test(normalized)
    || /(?:^|\/)(?:\.github\/workflows|\.husky|scripts|bin)(?:\/|$)/u.test(normalized)
    || /(?:^|\/)(?:docker-entrypoint[^/]*|[^/]+\.(?:service|socket|timer|target))$/u.test(normalized)
    || /^\.env(?:\.|$)/u.test(base)
    || /(?:^|[._-])config\.(?:js|cjs|mjs|ts|cts|mts)$/u.test(base)
    || /\.(?:bash|fish|sh|zsh)$/u.test(base);
}

function boundedImplementationPath(value: string, cwd: string): boolean {
  if (!value || value.startsWith('-') || value.includes('\\')
    || hasDynamicOrGlobTargetSyntax(value) || posix.isAbsolute(value)) return false;
  const resolved = normalizeStaticRemotePath(value, cwd);
  if (!resolved || resolved === cwd || !resolved.startsWith(`${cwd}/`)) return false;
  const relative = posix.relative(cwd, resolved);
  return relative !== '.git' && !relative.startsWith('.git/')
    && !boundedImplementationSensitiveControlPath(relative);
}

function boundedImplementationTouchesGitControl(value: string, cwd: string): boolean {
  const candidate = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
  const resolved = normalizeStaticRemotePath(candidate, cwd);
  if (!resolved || !resolved.startsWith(`${cwd}/`)) return false;
  const relative = posix.relative(cwd, resolved);
  return relative === '.git' || relative.startsWith('.git/');
}

function boundedImplementationOperandEscapesCwd(value: string, cwd: string): boolean {
  const candidate = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
  if (/(?:^|\/)\.\.(?:\/|$)/u.test(candidate) || candidate.startsWith('~/')) return true;
  return posix.isAbsolute(candidate)
    && candidate !== cwd && !candidate.startsWith(`${cwd}/`);
}

function isExactBoundedParentRulesProbe(words: readonly string[]): boolean {
  return words.join('\0') === [
    'find', '..', '-maxdepth', '3', '-type', 'f', '(', '-name', 'AGENTS.md',
    '-o', '-name', 'CLAUDE.md', ')', '-print',
  ].join('\0');
}

function boundedImplementationRedirects(
  node: Record<string, unknown>,
  cwd: string,
): boolean {
  const suffix = Array.isArray(node.suffix)
    ? node.suffix as Array<Record<string, unknown>>
    : [];
  return suffix.every((item) => {
    if (item.type !== 'Redirect') return true;
    const op = (item.op as { text?: unknown } | undefined)?.text;
    const file = (item.file as { text?: unknown; expansion?: unknown[] } | undefined);
    if (typeof op !== 'string' || typeof file?.text !== 'string'
      || file.expansion?.length) return false;
    if (file.text === '/dev/null' && ['>', '>>', '<'].includes(op)) return true;
    return ['>', '>>', '<'].includes(op)
      && boundedImplementationPath(file.text, cwd);
  });
}

function boundedImplementationGitCommand(words: string[], cwd: string): boolean {
  if (words.some(word => /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word)
    || /^(?:[^/@\s]+@)?[^/:\s]+:.+/u.test(word))) return false;
  let actionIndex = 1;
  while (words[actionIndex]?.startsWith('-')) {
    if (!['--no-pager', '--paginate'].includes(words[actionIndex]!)) return false;
    actionIndex += 1;
  }
  const action = words[actionIndex]?.toLowerCase();
  if (!action || !BOUNDED_IMPLEMENTATION_GIT_ACTIONS.has(action)) return false;
  const tail = words.slice(actionIndex + 1);
  const gitOperandEscapesCwd = tail.some(word => (
    boundedImplementationOperandEscapesCwd(word, cwd)
  ));
  if (gitOperandEscapesCwd) return false;
  if (tail.some(word => /^(?:-c|--config-env|--exec-path|--git-dir|--work-tree)(?:=|$)/u.test(word)
    || /^--(?:receive-pack|upload-pack|exec|force|force-with-lease|delete|repo|repository|pathspec-from-file|ext-diff|textconv)(?:=|$)/u.test(word)
    || /^--output(?:=|$)/u.test(word)
    || /^(?:-f|--all|--mirror|--prune)$/u.test(word)
    || word === '--unsafe-paths')) return false;
  if (action === 'remote') {
    const operation = tail.find(word => !word.startsWith('-'));
    return !operation || ['get-url', 'show'].includes(operation);
  }
  if (action === 'add') {
    const operands = tail.filter(word => word !== '--' && !word.startsWith('-'));
    return operands.length > 0
      && tail.every(word => word === '--' || !word.startsWith('-'))
      && operands.every(operand => boundedImplementationPath(operand, cwd));
  }
  // Branch creation/renaming/upstream edits write refs or .git/config, while
  // --edit-description invokes an editor. The lifecycle grant needs only the
  // two read forms used to inspect the current checkout.
  if (action === 'branch') {
    return tail.length === 0
      || tail.length === 1 && tail[0] === '--show-current';
  }
  if (action === 'commit') {
    if (tail.some(word => /^(?:-e|--edit|-i|--interactive|-p|--patch|-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash|--template|--amend)(?:=|$)/u.test(word))) {
      return false;
    }
    // A message supplied on the command line prevents Git from launching an
    // editor. A bare commit therefore remains outside this automatic grant.
    return tail.some((word, index) => (
      word === '-m' || word === '--message'
        ? !!tail[index + 1]
        : /^-m.+/u.test(word) || /^--message=.+/u.test(word)
    ));
  }
  if (action === 'apply') {
    const operands = tail.filter(word => !word.startsWith('-'));
    return operands.length > 0
      && tail.every(word => !word.startsWith('-') || ['--3way', '--check', '--index'].includes(word))
      && operands.every(operand => boundedImplementationPath(operand, cwd));
  }
  if (action === 'push' || action === 'fetch') {
    const allowedFlags = action === 'push'
      ? new Set(['--atomic', '--dry-run', '--porcelain'])
      : new Set<string>();
    if (tail.some(word => word.startsWith('-') && !allowedFlags.has(word))) return false;
    const positionals = tail.filter(word => !word.startsWith('-'));
    if (action === 'fetch') return positionals.length === 1 && positionals[0] === 'origin';
    return positionals.length === 2 && positionals[0] === 'origin'
      && positionals[1] === 'HEAD';
  }
  return true;
}

function boundedImplementationPackageTestArguments(words: string[], cwd: string): boolean {
  return words.length > 0 && words.every(word => (
    ['--', '--run', '--runInBand', '--passWithNoTests'].includes(word)
    || boundedImplementationPath(word, cwd)
  ));
}

function boundedImplementationPackageCommand(words: string[], cwd: string): boolean {
  if (isBoundedProjectPackageCommand(words) !== true) return false;
  if (words.some(word => /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word)
    || /^(?:--?(?:registry|prefix|cwd|dir|filter(?:-prod)?|workspace|workspaces|workspace-root|include-workspace-root|recursive|ws|project|project-dir|root|config|userconfig|globalconfig|target|environment|host|server|url|endpoint))(?:=|$)/iu.test(word)
    || /^-(?:C|F|R|T|W|r|w)(?:=.*|.+)?$/u.test(word)
    || /^(?:prod|production)$/iu.test(word))) return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = words[operationIndex]?.toLowerCase();
  if (!operation) return false;
  if (operation === 'run') {
    const script = words[operationIndex + 1];
    if (!script || !(LOCAL_PACKAGE_SCRIPT.test(script) || BOUNDED_DEPLOYMENT_SCRIPT.test(script))) return false;
    const tail = words.slice(operationIndex + 2);
    if (tail.length === 0) return true;
    return /^(?:test|check)(?:$|[:-])/iu.test(script)
      && boundedImplementationPackageTestArguments(tail, cwd);
  }
  if (LOCAL_PACKAGE_SCRIPT.test(operation) || BOUNDED_DEPLOYMENT_SCRIPT.test(operation)) {
    const tail = words.slice(operationIndex + 1);
    if (tail.length === 0) return true;
    return /^(?:test|check)(?:$|[:-])/iu.test(operation)
      && boundedImplementationPackageTestArguments(tail, cwd);
  }
  // Dependency restoration is bounded to the checked-out project's lockfile;
  // package-name/URL operands remain outside this compatibility grant.
  return ['ci', 'install'].includes(operation)
    && words.slice(operationIndex + 1).length === 1
    && words[operationIndex + 1] === '--ignore-scripts';
}

function boundedImplementationComposeCommand(words: string[], cwd: string): boolean {
  if (!['docker', 'podman'].includes(words[0] ?? '') || words[1] !== 'compose') return false;
  let actionIndex = 2;
  let externalComposeFile = false;
  if (words[actionIndex] === '-f' || words[actionIndex] === '--file') {
    externalComposeFile = words[actionIndex + 1] === '/srv/workspace/docker-compose.apps.yml'
      && cwd === '/srv/workspace/zero';
    if (!externalComposeFile) return false;
    actionIndex += 2;
  } else if (words[actionIndex]?.startsWith('--file=')) {
    externalComposeFile = words[actionIndex] === '--file=/srv/workspace/docker-compose.apps.yml'
      && cwd === '/srv/workspace/zero';
    if (!externalComposeFile) return false;
    actionIndex += 1;
  }
  const action = words[actionIndex]?.toLowerCase();
  if (!action || !BOUNDED_IMPLEMENTATION_COMPOSE_ACTIONS.has(action)) return false;
  const actionTail = words.slice(actionIndex + 1);
  if (actionTail.some(word => /^(?:-H|--host|--context|-f|--file|-p|--project-name|--project-directory|--env-file|--profile)(?:=|$)/u.test(word)
    || /^--push$/u.test(word)
    || /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word))) return false;
  const readActionOptions = new Map<string, ReadonlySet<string>>([
    ['config', new Set(['--hash', '--images', '--no-interpolate', '--profiles', '--quiet', '--services', '--volumes'])],
    ['images', new Set(['--quiet'])],
    ['logs', new Set(['--no-color', '--timestamps'])],
    ['ls', new Set(['--all', '--quiet'])],
    ['ps', new Set(['--all', '--quiet', '--services'])],
    ['top', new Set([])],
    ['version', new Set([])],
  ]);
  const allowedOptions = BOUNDED_COMPOSE_ACTION_OPTIONS.get(action)
    ?? readActionOptions.get(action);
  if (!allowedOptions || actionTail.some(word => word.startsWith('-')
    && !allowedOptions.has(word))) return false;
  if (action === 'up' && !actionTail.some(word => word === '-d' || word === '--detach')) {
    return false;
  }
  if (externalComposeFile) {
    if (!['build', 'logs', 'ps', 'pull', 'restart', 'start', 'stop', 'up'].includes(action)) return false;
    const services = actionTail.filter(word => !word.startsWith('-'));
    if (services.length !== 1 || services[0] !== 'zero') return false;
  }
  return true;
}

function boundedImplementationFileMutation(words: string[], cwd: string): boolean {
  const executable = words[0]!;
  let operands: string[] = [];
  if (executable === 'chmod') {
    const modeIndex = words.findIndex((word, index) => index > 0 && /^[0-7]{3,4}$/u.test(word));
    if (modeIndex < 0) return false;
    operands = words.slice(modeIndex + 1);
  } else {
    const allowedOptions = new Set([
      '--', '--force', '--parents', '--recursive', '-R', '-a', '-f', '-fr', '-p', '-r', '-rf',
    ]);
    if (words.slice(1).some(word => word.startsWith('-') && !allowedOptions.has(word))) return false;
    operands = words.slice(1).filter(word => !word.startsWith('-'));
  }
  if (operands.length === 0) return false;
  if (['cp', 'mv'].includes(executable) && operands.length < 2) return false;
  return operands.every(operand => boundedImplementationPath(operand, cwd));
}

function boundedImplementationSimpleCommand(words: string[], cwd: string): boolean {
  if (words.length === 0 || hasUnsafeRemoteWrapperChain(words)) return false;
  const executable = words[0]!;
  if (executable !== basename(executable)) return false;
  if (executable === 'set') {
    return words.slice(1).every((word, index, tail) => (
      /^[-+](?:e|u|eu|ue)$/u.test(word)
      || word === '-o' && tail[index + 1] === 'pipefail'
      || word === 'pipefail' && tail[index - 1] === '-o'
    ));
  }
  if (BOUNDED_IMPLEMENTATION_READ_EXECUTABLES.has(executable)) {
    if (executable === 'find' && words.some(word => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/u.test(word))) return false;
    if (executable === 'rg' && words.some(word => /^--(?:pre|config|hostname-bin)(?:-|=|$)/u.test(word))) return false;
    if (executable === 'date' && words.some(word => word === '-s' || /^--set(?:=|$)/u.test(word))) return false;
    if (executable === 'sort' && words.some(word => /^-o.+/u.test(word)
      || word === '-o' || /^--(?:output|compress-program)(?:=|$)/u.test(word))) return false;
    if (executable === 'jq') {
      if (words.slice(1).some(word => /(?:^|[^A-Za-z0-9_])(?:\$ENV|env)(?:[^A-Za-z0-9_]|$)/iu.test(word)
        || /^(?:-f(?:.+)?|--from-file(?:=|$)|-L(?:.+)?|--library-path(?:=|$))/u.test(word))) return false;
      for (let index = 1; index < words.length; index += 1) {
        const word = words[index]!;
        if (['--rawfile', '--slurpfile', '--argfile'].includes(word)) {
          const path = words[index + 2];
          if (!path || !boundedImplementationPath(path, cwd)) return false;
          index += 2;
          continue;
        }
        const attached = /^(?:--rawfile|--slurpfile|--argfile)=(.+)$/u.exec(word)?.[1];
        if (attached && !boundedImplementationPath(attached, cwd)) return false;
      }
    }
    if (!isExactBoundedParentRulesProbe(words)
      && words.slice(1).some(word => word !== '/dev/null'
        && (boundedImplementationOperandEscapesCwd(word, cwd)
          || boundedImplementationTouchesGitControl(word, cwd)))) return false;
    return true;
  }
  if (executable === 'sed') {
    if (words.slice(1).some(word => /^(?:-f(?:.+)?|--file(?:=|$))/u.test(word))) return false;
    const mutationOperands = sedInPlaceMutationFileOperands(words);
    if (mutationOperands !== undefined) {
      return mutationOperands.length > 0
        && mutationOperands.every(operand => boundedImplementationPath(operand, cwd));
    }
    return !words.slice(1).some(word => boundedImplementationOperandEscapesCwd(word, cwd)
        || boundedImplementationTouchesGitControl(word, cwd))
      && isProvablyReadOnlyShellCommand(words.join(' '));
  }
  if (executable === 'git') return boundedImplementationGitCommand(words, cwd);
  if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
    return boundedImplementationPackageCommand(words, cwd);
  }
  if (executable === 'docker' || executable === 'podman') {
    return boundedImplementationComposeCommand(words, cwd);
  }
  if (BOUNDED_IMPLEMENTATION_FILE_MUTATORS.has(executable)) {
    return boundedImplementationFileMutation(words, cwd);
  }
  if (executable === 'systemctl' || executable === 'service') {
    const serviceAction = executable === 'systemctl'
      ? words[firstCliActionIndex(words, 1)]?.toLowerCase()
      : words[2]?.toLowerCase();
    if (!serviceAction || !['reload', 'restart', 'start'].includes(serviceAction)) return false;
    const project = remoteScopeFromPath(cwd);
    const targets = remoteServiceMutationScopeTargets(words);
    return !!project && !!targets && targets.length > 0
      && targets.every(target => humanizeRemoteIdentifier(target) === project);
  }
  return false;
}

function boundedImplementationHasOutputRedirect(node: Record<string, unknown>): boolean {
  const suffix = Array.isArray(node.suffix)
    ? node.suffix as Array<Record<string, unknown>>
    : [];
  return suffix.some((item) => {
    if (item.type !== 'Redirect') return false;
    const op = (item.op as { text?: unknown } | undefined)?.text;
    const file = (item.file as { text?: unknown } | undefined)?.text;
    return (op === '>' || op === '>>') && file !== '/dev/null';
  });
}

function boundedImplementationWritesProjectFiles(
  words: string[],
  node: Record<string, unknown>,
): boolean {
  if (boundedImplementationHasOutputRedirect(node)) return true;
  const executable = words[0];
  if (executable === 'sed' && sedInPlaceMutationFileOperands(words) !== undefined) return true;
  if (executable && BOUNDED_IMPLEMENTATION_FILE_MUTATORS.has(executable)) return true;
  if (executable === 'git') {
    const action = words.slice(1).find(word => !word.startsWith('-'))?.toLowerCase();
    return action === 'apply' || action === 'pull';
  }
  if (executable && PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
    const operationIndex = packageManagerActionIndex(words);
    const operation = words[operationIndex]?.toLowerCase();
    return operation === 'ci' || operation === 'install';
  }
  return false;
}

function boundedImplementationInvokesMutableRuntime(words: string[]): boolean {
  const executable = words[0];
  if (executable === 'docker' || executable === 'podman'
    || executable === 'systemctl' || executable === 'service') return true;
  if (!executable || !PACKAGE_MANAGER_EXECUTABLES.has(executable)) return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = words[operationIndex]?.toLowerCase();
  return !!operation && operation !== 'ci' && operation !== 'install';
}

/** Prove the whole rbw shell graph, not merely the sensitive leaf selected by
 * the category merger. This prevents an allowed deploy/edit command from
 * hiding a second database, network, mail or interpreter side effect. */
function isBoundedRemoteImplementationLifecycleCommand(command: string, cwd: string): boolean {
  if (!command || !posix.isAbsolute(cwd) || posix.normalize(cwd) !== cwd) return false;
  let ast: AstNode;
  try {
    ast = bashParser(command) as AstNode;
  } catch {
    return false;
  }
  if (hasDynamicShellExpansion(ast) || hasUnsafeRemoteInvocationMetadata(ast)) return false;
  const validatedCommands: Array<{ words: string[]; node: Record<string, unknown> }> = [];
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    if (record.async === true) return false;
    if (record.type === 'Script' || record.type === 'Pipeline') {
      return Array.isArray(record.commands) && record.commands.length > 0
        && record.commands.every(visit);
    }
    if (record.type === 'LogicalExpression') {
      return (record.op === 'and' || record.op === 'or')
        && visit(record.left) && visit(record.right);
    }
    if (record.type !== 'Command' || Array.isArray(record.prefix) && record.prefix.length > 0
      || !boundedImplementationRedirects(record, cwd)) return false;
    const name = record.name as { text?: unknown; expansion?: unknown[] } | undefined;
    if (typeof name?.text !== 'string' || name.expansion?.length) return false;
    const words = [name.text];
    for (const rawSuffix of Array.isArray(record.suffix) ? record.suffix : []) {
      const suffix = rawSuffix as { type?: unknown; text?: unknown; expansion?: unknown[] };
      if (suffix.type === 'Redirect') continue;
      if (suffix.type !== 'Word' || typeof suffix.text !== 'string' || suffix.expansion?.length) return false;
      words.push(suffix.text);
    }
    if (!boundedImplementationSimpleCommand(words, cwd)) return false;
    validatedCommands.push({ words, node: record });
    return true;
  };
  if (!visit(ast)) return false;
  // A per-leaf allowlist is insufficient when an earlier leaf rewrites the
  // manifest/config/script consumed by a later package, compose, or service
  // command. Split those steps into separately checked calls instead of
  // granting an opaque self-reprogramming graph.
  return !(validatedCommands.some(command => (
    boundedImplementationWritesProjectFiles(command.words, command.node)
  )) && validatedCommands.some(command => (
    boundedImplementationInvokesMutableRuntime(command.words)
  )));
}

function boundedRemoteReadHasHiddenSideEffect(command: string): boolean {
  const commands = parseSimpleCommands(command);
  if (commands.length === 0) return false;
  return commands.some((rawWords) => {
    const words = unwrapCommand(rawWords);
    const executable = basename(words[0] ?? '');
    if (executable === 'rg') {
      return words.slice(1).some(word => (
        /^--(?:pre|config|hostname-bin)(?:-|=|$)/u.test(word)
      ));
    }
    if (executable === 'find') {
      return words.slice(1).some(word => (
        /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/u.test(word)
      ));
    }
    if (executable === 'git') {
      return words.slice(1).some(word => (
        /^--output(?:=|$)/u.test(word)
        || /^--(?:ext-diff|textconv)(?:=|$)/u.test(word)
      ));
    }
    if (executable === 'sed') {
      return words.slice(1).some(word => /^(?:-f(?:.+)?|--file(?:=|$))/u.test(word));
    }
    if (executable === 'jq') {
      return words.slice(1).some(word => (
        /(?:^|[^A-Za-z0-9_])(?:\$ENV|env)(?:[^A-Za-z0-9_]|$)/iu.test(word)
        || /^(?:-f(?:.+)?|--from-file(?:=|$)|-L(?:.+)?|--library-path(?:=|$))/u.test(word)
      ));
    }
    if (executable === 'sort') {
      return words.slice(1).some(word => (
        /^-o.+/u.test(word) || word === '-o'
        || /^--(?:output|compress-program)(?:=|$)/u.test(word)
      ));
    }
    return executable === 'date'
      && words.slice(1).some(word => word === '-s' || /^--set(?:=|$)/u.test(word));
  });
}

function findSshHostIndex(words: string[]): number {
  const optionsWithValues = new Set([
    '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o',
    '-p', '-Q', '-R', '-S', '-W', '-w',
  ]);
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return index;
  }
  return -1;
}

function positionalAfter(words: string[], actionIndex: number): string[] {
  const positionals: string[] = [];
  const optionsWithValues = new Set([
    '--app', '--context', '--env', '--environment', '--namespace', '--project', '--repo',
    '--secret-id', '--service', '--target', '--vault-name', '-a', '-e', '-n', '-p', '-t',
  ]);
  for (let index = actionIndex + 1; index < words.length; index++) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    positionals.push(word);
  }
  return positionals;
}

/** Scan headers once; malformed repeated headers cannot trigger backtracking. */
function redactAuthenticationHeaders(command: string): string {
  const pattern = /([a-z0-9-]{1,256})[ \t]{0,256}:[ \t]{0,256}/giu;
  let cursor = 0;
  let output = '';
  for (const match of command.matchAll(pattern)) {
    const start = match.index;
    if (start < cursor) continue;
    const name = match[1]!.toLowerCase().replace(/-/g, '_');
    if (!['authorization', 'proxy_authorization', 'cookie', 'set_cookie'].includes(name)
      && !['api_key', 'apikey', 'access_token', 'refresh_token', 'auth_token', 'csrf_token', 'xsrf_token', 'client_secret', 'password', 'credential', 'session_key']
        .some(token => name.includes(token))) continue;
    let end = start + match[0].length;
    while (end < command.length && !['"', "'", '\r', '\n'].includes(command[end]!)) end++;
    output += command.slice(cursor, start) + match[0] + '[REDACTED]';
    cursor = end;
  }
  return output + command.slice(cursor);
}

function redactCommandPreview(command: string, category: SensitiveExternalActionCategory): string {
  if (category === 'secret_transfer') return '[Sensitive credential operation — values redacted]';
  return redactAuthenticationHeaders(command)
    // Preserve the header name so the prompt remains useful, but never expose
    // cookies or key-like authentication header values. Handle quoted headers
    // before bare values so a cookie containing spaces/semicolons is redacted
    // as one unit rather than leaking its suffix.
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|csrf[_-]?token|xsrf[_-]?token|client[_-]?secret|token|secret|password|credential|session[_-]?key|cookie)\s*[=:]\s*)(["'])[^'"\r\n]*\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*["']?)[^\s,"'};]+/gi, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|secret|password)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeHttpHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

function makeAction(
  category: SensitiveExternalActionCategory,
  promptType: SensitiveExternalAction['promptType'],
  commandPreview: string,
  targetCandidates: string[],
  authorizationTermGroups?: string[][],
  conditionalTargetCandidates?: SensitiveConditionalTarget[],
): SensitiveExternalAction {
  const details = ACTION_DETAILS[category];
  const targets = uniqueTargets(targetCandidates);
  const targetLabel = targets[0] ? ` Target: ${targets[0]}.` : '';
  return {
    category,
    promptType,
    description: `Explicit confirmation required: ${details.description}.${targetLabel}`,
    commandPreview,
    reason: details.reason,
    impact: details.impact,
    targetCandidates: targets,
    ...(conditionalTargetCandidates && conditionalTargetCandidates.length > 0
      ? { conditionalTargetCandidates: uniqueConditionalTargets(conditionalTargetCandidates) }
      : {}),
    ...(authorizationTermGroups ? { authorizationTermGroups } : {}),
  };
}

function uniqueConditionalTargets(
  values: readonly SensitiveConditionalTarget[],
): SensitiveConditionalTarget[] {
  const seen = new Set<string>();
  const result: SensitiveConditionalTarget[] = [];
  for (const candidate of values) {
    const value = candidate.value.trim();
    if (!value || value.length > 200) continue;
    const key = `${candidate.kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: candidate.kind, value });
  }
  return result;
}

const GENERIC_MUTATION_TERM_ALIASES: Record<string, string[]> = {
  accept: ['accept', 'accepte', 'accepter'],
  activate: ['activate', 'active', 'activer'],
  add: ['add', 'ajoute', 'ajouter'],
  approve: ['approve', 'approuve', 'approuver'],
  archive: ['archive', 'archiver'],
  assign: ['assign', 'assigne', 'assigner'],
  cancel: ['cancel', 'annule', 'annuler'],
  close: ['close', 'ferme', 'fermer'],
  configure: ['configure', 'configurer'],
  copy: ['copy', 'copie', 'copier'],
  create: ['create', 'cree', 'creer'],
  delete: ['delete', 'remove', 'destroy', 'erase', 'purge', 'supprime', 'supprimer'],
  destroy: ['delete', 'destroy', 'supprime', 'supprimer'],
  disable: ['disable', 'desactive', 'desactiver'],
  edit: ['edit', 'update', 'modify', 'modifie', 'modifier', 'mets', 'mettre', 'mets a jour', 'mettre a jour'],
  enable: ['enable', 'active', 'activer'],
  execute: ['execute', 'run', 'trigger', 'execute', 'executer', 'lance', 'lancer'],
  grant: ['grant', 'accorde', 'accorder'],
  install: ['install', 'installe', 'installer'],
  invite: ['invite', 'inviter'],
  merge: ['merge', 'fusionne', 'fusionner'],
  modify: ['modify', 'edit', 'update', 'modifie', 'modifier', 'mets', 'mettre', 'mets a jour', 'mettre a jour'],
  move: ['move', 'deplace', 'deplacer'],
  patch: ['patch', 'corrige', 'corriger', 'modifie', 'modifier'],
  post: ['post', 'publie', 'publier'],
  remove: ['remove', 'delete', 'supprime', 'supprimer'],
  rename: ['rename', 'renomme', 'renommer'],
  replace: ['replace', 'remplace', 'remplacer'],
  reset: ['reset', 'reinitialise', 'reinitialiser'],
  restore: ['restore', 'restaure', 'restaurer'],
  revoke: ['revoke', 'revoque', 'revoquer'],
  rotate: ['rotate', 'tourne', 'renouvelle', 'renouveler'],
  run: ['run', 'execute', 'trigger', 'lance', 'lancer', 'execute', 'executer'],
  save: ['save', 'enregistre', 'enregistrer'],
  schedule: ['schedule', 'planifie', 'planifier'],
  set: ['set', 'configure', 'definis', 'definir'],
  start: ['start', 'demarre', 'demarrer', 'lance', 'lancer'],
  stop: ['stop', 'arrete', 'arreter'],
  submit: ['submit', 'soumets', 'soumettre'],
  trigger: ['trigger', 'run', 'declenche', 'declencher', 'lance', 'lancer'],
  uninstall: ['uninstall', 'desinstalle', 'desinstaller'],
  update: ['update', 'edit', 'modify', 'mets', 'mettre', 'mets a jour', 'mettre a jour', 'modifie', 'modifier'],
  upload: ['upload', 'televerse', 'televerser'],
  write: ['write', 'ecris', 'ecrire'],
};

const NON_DESTRUCTIVE_IMPLEMENTATION_TOKENS = new Set([
  'activate', 'add', 'alter', 'append', 'apply', 'configure', 'copy', 'create',
  'edit', 'enable', 'execute', 'export', 'import', 'install', 'link', 'mark',
  'modify', 'move', 'patch', 'replace', 'restore', 'run', 'save', 'set', 'start',
  'submit', 'trigger', 'update', 'upload', 'upsert', 'write',
]);

const IN_SCOPE_IMPLEMENTATION_ALIASES = [
  'apply', 'applique', 'appliquer', 'change', 'change le', 'corrige', 'corriger',
  'deploy', 'deployment', 'deploie', 'deploiement', 'deployer', 'fix', 'implement',
  'implante', 'implanter', 'mets a jour', 'mettre a jour', 'modifie', 'modifier',
  'reactivate', 'reactive', 'reactiver',
];

const REMOTE_SERVICE_LIFECYCLE_AUTHORIZATION_TERMS = [[
  ...ACTION_DETAILS.service_restart.authorizationTermGroups[0]!,
  'deploy', 'deployment', 'deploie', 'deploiement', 'deployer',
]];

function genericMutationAuthorizationTerms(
  token: string | undefined,
  allowImplementationAliases = false,
): string[][] {
  if (!token) return ACTION_DETAILS.external_mutation.authorizationTermGroups;
  const aliases = GENERIC_MUTATION_TERM_ALIASES[token] ?? [token];
  return [allowImplementationAliases && NON_DESTRUCTIVE_IMPLEMENTATION_TOKENS.has(token)
    ? [...new Set([...aliases, ...IN_SCOPE_IMPLEMENTATION_ALIASES])]
    : aliases];
}

function getGitPush(words: string[]): { actionIndex: number; targets: string[] } | null {
  if (basename(words[0] ?? '') !== 'git') return null;
  let index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word)) {
      index += 2;
      continue;
    }
    if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=') || word === '--no-pager') {
      index += 1;
      continue;
    }
    break;
  }
  if (words[index]?.toLowerCase() !== 'push') return null;
  const args = words.slice(index + 1);
  if (args.some(arg => arg === '--dry-run' || arg === '-n')) return null;
  const positionals = args.filter(arg => !arg.startsWith('-'));
  const remote = positionals[0];
  const rawRef = positionals[1];
  const destinationRef = rawRef?.includes(':') ? rawRef.split(':').pop() : rawRef;
  const normalizedRef = destinationRef?.replace(/^refs\/heads\//, '');
  return {
    actionIndex: index,
    targets: uniqueTargets([
      remote && normalizedRef ? `${remote} ${normalizedRef}` : remote,
    ]),
  };
}

function classifyDeployment(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  if (lowerWords.some(word => ['--dry-run', '--preview'].includes(word))) return null;
  const dockerActionIndex = command === 'docker'
    ? firstCliActionIndex(words, 1, new Set(['--config', '--context', '--host', '-H', '--log-level']))
    : -1;
  const kubectlActionIndex = command === 'kubectl'
    ? firstCliActionIndex(words, 1, new Set(['--context', '--namespace', '-n', '--server', '--user']))
    : -1;

  let actionIndex = -1;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && /^deploy(?::[a-z0-9_-]+)?$/.test(word));
  } else if (/^deploy(?:[-_.][a-z0-9_-]+)?(?:\.sh)?$/.test(command)) {
    actionIndex = 0;
  } else if (['vercel', 'firebase', 'fly', 'flyctl', 'wrangler', 'render'].includes(command)) {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && word === 'deploy');
    if (command === 'vercel' && actionIndex < 0 && lowerWords.includes('--prod')) actionIndex = 0;
  } else if (command === 'railway' && lowerWords[1] === 'up') {
    actionIndex = 1;
  } else if (command === 'gcloud') {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && word === 'deploy');
  } else if (command === 'kubectl' && ['apply', 'replace'].includes(lowerWords[kubectlActionIndex] ?? '')) {
    actionIndex = kubectlActionIndex;
  } else if (command === 'helm' && ['install', 'upgrade'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
  } else if (command === 'terraform' && lowerWords[1] === 'apply') {
    actionIndex = 1;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'stack'
    && lowerWords[dockerActionIndex + 1] === 'deploy') {
    actionIndex = dockerActionIndex + 1;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'compose') {
    // `compose up` may create or recreate a shared service. Options such as
    // `--profile` can appear before the action (as in the audited prod command).
    actionIndex = lowerWords.findIndex((word, index) => index > dockerActionIndex && word === 'up');
  } else if (command === 'gh' && lowerWords[1] === 'workflow' && lowerWords[2] === 'run') {
    actionIndex = 2;
  }
  if (actionIndex < 0) return null;

  const namedTargets = [
    optionValue(words, ['--app', '-a']),
    optionValue(words, ['--environment', '--env', '-e']),
    optionValue(words, ['--project', '-p']),
    optionValue(words, ['--service']),
    optionValue(words, ['--target', '-t']),
    optionValue(words, ['--namespace', '-n']),
    optionValue(words, ['--context']),
    optionValue(words, ['--profile']),
  ];
  return {
    actionIndex,
    targets: uniqueTargets([...namedTargets, ...positionalAfter(words, actionIndex)]),
  };
}

function isRemotePythonSecretWrite(command: string): boolean {
  return /\bpython(?:[0-9.]+)?\b/i.test(command)
    && /\.write_(?:text|bytes)\s*\(/i.test(command)
    && /(?:^|[/"'])\.env(?:\.[A-Za-z0-9_-]+)?\b/i.test(command)
    && /(?:NIGHT_AGENT_API_KEY|api[_-]?key|secret|credential|token|password|private[_-]?key)/i.test(command);
}

function isRemoteShellSecretWrite(command: string): boolean {
  const sensitiveValue = /(?:NIGHT_AGENT_API_KEY|api[_-]?key|secret|credential|token|password|private[_-]?key)/i;
  const secretDestination = /(?:>{1,2}\s*|\btee(?:\s+-a)?\s+)["']?[^\s"']*(?:\.env(?:\.[A-Za-z0-9_-]+)?|secrets?|credentials?|api[_-]?keys?|private[_-]?keys?)(?:\b|[/_.-])/i;
  return sensitiveValue.test(command) && secretDestination.test(command);
}

function isRemoteInlineSecretWrite(command: string): boolean {
  return isRemotePythonSecretWrite(command) || isRemoteShellSecretWrite(command);
}

function classifyRestart(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  let actionIndex = -1;
  let targetStart = -1;

  const systemctlActionIndex = command === 'systemctl'
    ? firstCliActionIndex(words, 1, new Set(['-H', '--host', '-M', '--machine', '--root', '--image']))
    : -1;
  const dockerActionIndex = command === 'docker'
    ? firstCliActionIndex(words, 1, new Set(['--config', '--context', '--host', '-H', '--log-level']))
    : -1;
  const kubectlActionIndex = command === 'kubectl'
    ? firstCliActionIndex(words, 1, new Set(['--context', '--namespace', '-n', '--server', '--user']))
    : -1;

  if (command === 'systemctl' && ['start', 'restart', 'try-restart'].includes(lowerWords[systemctlActionIndex] ?? '')) {
    actionIndex = systemctlActionIndex;
    targetStart = actionIndex + 1;
  } else if (command === 'service' && ['start', 'restart'].includes(lowerWords[2] ?? '')) {
    actionIndex = 2;
    targetStart = 1;
  } else if (command === 'docker' && ['start', 'restart'].includes(lowerWords[dockerActionIndex] ?? '')) {
    actionIndex = dockerActionIndex;
    targetStart = actionIndex + 1;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'compose') {
    actionIndex = lowerWords.findIndex((word, index) => index > dockerActionIndex && word === 'restart');
    targetStart = actionIndex + 1;
  } else if (['pm2', 'supervisorctl'].includes(command) && ['restart', 'reload'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
    targetStart = 2;
  } else if (command === 'kubectl' && lowerWords[kubectlActionIndex] === 'rollout'
    && lowerWords[kubectlActionIndex + 1] === 'restart') {
    actionIndex = kubectlActionIndex + 1;
    targetStart = actionIndex + 1;
  } else if (command === 'brew' && lowerWords[1] === 'services' && lowerWords[2] === 'restart') {
    actionIndex = 2;
    targetStart = 3;
  } else if (command === 'launchctl' && lowerWords[1] === 'kickstart') {
    actionIndex = 1;
    targetStart = 2;
  }
  if (actionIndex < 0) return null;
  return {
    actionIndex,
    targets: uniqueTargets(positionalAfter(words, actionIndex)),
  };
}

function classifySecretWrite(words: string[], rawCommand: string): string[] | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  const rawLower = rawCommand.toLowerCase();
  const sensitiveMarker = /(?:^|[/_.-])(?:\.env|secret|credential|api[_-]?key|private[_-]?key|id_rsa|id_ed25519)(?=$|[\s/_.-])/i;

  if (['scp', 'rsync', 'sftp'].includes(command)) {
    const remoteTarget = words.find(word => /^(?:[^@/\s:]+@)?[^/\s:]+:(?:\/|~|[^/])/.test(word));
    if (remoteTarget && sensitiveMarker.test(rawCommand) && !/\.pub(?:\s|$)/i.test(rawCommand)) {
      return uniqueTargets([remoteTarget.split(':')[0]]);
    }
  }

  if (command === 'gh' && lowerWords[1] === 'secret' && ['set', 'delete'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([optionValue(words, ['--repo', '-R']), words[3]]);
  }
  if (command === 'kubectl' && ['create', 'apply'].includes(lowerWords[1] ?? '') && lowerWords.includes('secret')) {
    return uniqueTargets([
      optionValue(words, ['--namespace', '-n']),
      words[lowerWords.indexOf('secret') + 1],
    ]);
  }
  if (command === 'aws' && lowerWords[1] === 'secretsmanager' && ['put-secret-value', 'create-secret', 'update-secret'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([optionValue(words, ['--secret-id', '--name'])]);
  }
  if (command === 'gcloud' && lowerWords[1] === 'secrets' && (lowerWords.includes('add') || lowerWords.includes('create'))) {
    return uniqueTargets([words[2], optionValue(words, ['--project'])]);
  }
  if (command === 'az' && lowerWords[1] === 'keyvault' && lowerWords[2] === 'secret' && lowerWords[3] === 'set') {
    return uniqueTargets([optionValue(words, ['--vault-name']), optionValue(words, ['--name'])]);
  }
  if (command === 'vault' && lowerWords[1] === 'kv' && lowerWords[2] === 'put') {
    return uniqueTargets([words[3]]);
  }
  if (command === 'doppler' && lowerWords[1] === 'secrets' && lowerWords[2] === 'set') {
    return uniqueTargets([optionValue(words, ['--project']), optionValue(words, ['--config'])]);
  }
  if (command === 'vercel' && lowerWords[1] === 'env' && lowerWords[2] === 'add') {
    return uniqueTargets([words[3], words[4], optionValue(words, ['--scope'])]);
  }
  if (command === 'fly' || command === 'flyctl') {
    if (lowerWords[1] === 'secrets' && lowerWords[2] === 'set') return uniqueTargets([optionValue(words, ['--app', '-a'])]);
  }
  if (command === 'heroku' && lowerWords[1] === 'config:set') {
    return uniqueTargets([optionValue(words, ['--app', '-a'])]);
  }
  if (command === 'railway' && lowerWords[1] === 'variables' && lowerWords[2] === 'set') {
    return uniqueTargets([optionValue(words, ['--service']), optionValue(words, ['--environment'])]);
  }
  if (command === 'netlify' && lowerWords[1] === 'env:set') {
    return uniqueTargets([optionValue(words, ['--site'])]);
  }
  if (command === 'op' && lowerWords[1] === 'item' && ['create', 'edit'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([words[3], optionValue(words, ['--vault'])]);
  }
  if (['curl', 'wget'].includes(command)) {
    const writesRemote = /(?:\s|^)(?:-d|--data(?:-raw|-binary)?|-f|--form|-t|--upload-file|-x|--request\s+(?:post|put|patch))\b/i.test(rawLower);
    const carriesCredential = /(?:\$\{?[A-Za-z0-9_]*(?:secret|token|password|key)|\.env|credential|authorization\s*:|\b(?:api[_-]?key|secret|token|password)\b\s*[=:])/i.test(rawCommand);
    const credentialHeaderOrOption = /(?:authorization|x-api-key|x-auth-token|x-access-token)\s*:|(?:^|\s)(?:-u|--user|--cert|--key)(?:=|\s)/i.test(rawCommand);
    if ((writesRemote && carriesCredential) || credentialHeaderOrOption) {
      const destination = words.find(word => /^https?:\/\//i.test(word));
      return uniqueTargets([safeHttpHost(destination) ?? UNRESOLVED_EXTERNAL_TARGET]);
    }
  }
  return null;
}

interface HttpMutationDetails {
  method: string;
  host?: string;
  path: string;
  targets: string[];
}

function classifyHttpMutation(words: string[]): HttpMutationDetails | null {
  const command = basename(words[0] ?? '');
  if (command !== 'curl' && command !== 'wget') return null;
  let mutating = false;
  let forceGet = false;
  let method: string | undefined;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '-K' || word === '--config' || word.startsWith('--config=')) mutating = true;
    if (word === '-G' || word === '--get') forceGet = true;
    if (word === '-X' || word === '--request' || word === '--method') {
      method = words[index + 1]?.toUpperCase();
      index += 1;
      continue;
    }
    const inlineMethod = /^(?:-X|--request=|--method=)(POST|PUT|PATCH|DELETE)$/i.exec(word)?.[1];
    if (inlineMethod) method = inlineMethod.toUpperCase();
    if (/^-[dFT](?:.|$)/.test(word)
      || /^(?:--data(?:-ascii|-binary|-raw|-urlencode)?|--form(?:-string)?|--json|--upload-file|--post-data|--post-file|--body-data|--body-file)(?:=|$)/i.test(word)) {
      mutating = true;
    }
  }
  if (method && /^(?:POST|PUT|PATCH|DELETE)$/.test(method)) mutating = true;
  if (forceGet && !method) mutating = false;
  if (!mutating) return null;
  const destination = words.find(word => /^https?:\/\//i.test(word));
  let parsed: URL | undefined;
  try { if (destination) parsed = new URL(destination); } catch { /* fail closed below */ }
  const host = safeHttpHost(destination);
  return {
    method: method ?? (command === 'wget' || words.some(word => /^(?:-d|--data|--json|--form|--post-)/i.test(word)) ? 'POST' : 'PUT'),
    host,
    path: parsed?.pathname ?? '',
    targets: uniqueTargets([host ?? UNRESOLVED_EXTERNAL_TARGET]),
  };
}

function httpMutationCategory(details: HttpMutationDetails): SensitiveExternalActionCategory {
  const semantic = normalizedToolAction(details.path);
  if (/(?:^|_)(?:secrets?|credentials?|tokens?|api_keys?|private_keys?)(?:_|$)/.test(semantic)) return 'secret_transfer';
  if (/(?:^|_)(?:payment_intents?|payments?|charges?|payouts?|checkout|purchases?|trades?|orders?|buy|sell)(?:_|$)/.test(semantic)) return 'payment';
  if (/(?:^|_)(?:deploy|deploys|deployment|deployments)(?:_|$)/.test(semantic)) return 'deployment';
  if (/(?:^|_)(?:restart|restarts|reboot|rollout_restart)(?:_|$)/.test(semantic)) return 'service_restart';
  if (/(?:^|_)(?:send|deliver|forward|reply|messages?|emails?|notifications?|invites?|signatures?|edoc)(?:_|$)/.test(semantic)) return 'external_send';
  if (/(?:^|_)(?:publish|posts?|comments?|issues?|pulls?|releases?|reviews?|shares?)(?:_|$)/.test(semantic)) return 'external_publication';
  return 'external_mutation';
}

function classifyPaymentCli(words: string[]): string[] | null {
  const executable = basename(words[0] ?? '');
  const semantic = normalizedToolAction(words.slice(1).join('_'));
  if (executable === 'stripe'
    && /(?:^|_)(?:payment_intents?|payments?|charges?|payouts?|checkout)(?:_|$)/.test(semantic)) {
    return uniqueTargets([
      'stripe',
      optionValue(words, ['--account']),
      optionValue(words, ['--amount']),
      optionValue(words, ['--currency']),
      optionValue(words, ['--customer']),
    ]);
  }
  if (['alpaca', 'binance', 'broker', 'ibkr', 'trading'].includes(executable)
    && /(?:^|_)(?:trades?|orders?|buy|sell)(?:_|$)/.test(semantic)) {
    return uniqueTargets([
      optionValue(words, ['--account', '--account-id']),
      optionValue(words, ['--symbol']),
      executable,
    ]);
  }
  return null;
}

function extractLiteralBusinessTargets(command: string): string[] {
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

const HTTP_EXTERNAL_AUDIENCE_FIELDS = new Set([
  'to',
  'cc',
  'bcc',
  'blind_copy',
  'blind_copies',
  'carbon_copy',
  'carbon_copies',
  'recipient',
  'recipients',
  'recipient_email',
  'recipient_emails',
  'recipient_id',
  'recipient_ids',
  'signatory',
  'signatories',
  'signatory_email',
  'signatory_emails',
  'signatory_id',
  'signatory_ids',
  'channel',
  'channels',
  'channel_id',
  'channel_ids',
  'chat',
  'chats',
  'chat_id',
  'chat_ids',
  'room',
  'rooms',
  'room_id',
  'room_ids',
  'conversation',
  'conversations',
  'conversation_id',
  'conversation_ids',
  'thread',
  'threads',
  'thread_id',
  'thread_ids',
  'email',
  'emails',
  'phone',
  'phones',
  'phone_number',
  'phone_numbers',
  'customer',
  'customers',
  'customer_id',
  'customer_ids',
  'user',
  'users',
  'user_id',
  'user_ids',
  'username',
  'usernames',
  'destination',
  'destinations',
  'destination_id',
  'destination_ids',
  'audience',
  'audiences',
  'audience_id',
  'audience_ids',
  'group',
  'groups',
  'group_id',
  'group_ids',
  'mailing_list',
  'mailing_lists',
  'mailing_list_id',
  'mailing_list_ids',
  'subscriber',
  'subscribers',
  'subscriber_id',
  'subscriber_ids',
  'invitee',
  'invitees',
  'invitee_id',
  'invitee_ids',
  'queue',
  'queues',
  'topic',
  'topics',
  'routing_key',
  'routing_keys',
  'webhook_url',
  'webhook_urls',
  'endpoint_url',
  'endpoint_urls',
]);

const HTTP_EXTERNAL_SEND_NON_AUDIENCE_FIELDS = new Set([
  'subject', 'title', 'body', 'text', 'message', 'content', 'html', 'markdown',
  'description', 'template', 'template_id', 'template_name', 'template_data',
  'variables', 'metadata', 'locale', 'language', 'first_name', 'last_name', 'name',
  'filename', 'file_name', 'mime_type', 'content_type', 'attachment', 'attachments',
  'action', 'operation', 'method', 'path', 'api_version', 'version',
  'priority', 'importance', 'scheduled_at', 'send_at', 'timezone',
  'idempotency_key', 'tracking', 'track_opens', 'track_clicks',
  'test', 'test_mode', 'dry_run',
]);

const HTTP_CONDITIONAL_TARGET_FIELDS: Readonly<Record<string, SensitiveConditionalTargetKind>> = {
  contract: 'contract',
  contract_id: 'contract',
  document: 'document',
  document_id: 'document',
  envelope: 'envelope',
  envelope_id: 'envelope',
};

interface HttpExternalSendTargets {
  audienceTargets: string[];
  conditionalTargets: SensitiveConditionalTarget[];
  resolved: boolean;
}

interface HttpExternalSendAccumulator {
  audienceTargets: string[];
  conditionalTargets: SensitiveConditionalTarget[];
  resolved: boolean;
  sawAudience: boolean;
  visitedNodes: number;
}

function normalizedPayloadFieldName(value: string): string | undefined {
  const decoded = decodedLiteralValue(value);
  if (decoded === undefined) return undefined;
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasDynamicShellValue(value: string): boolean {
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

function isHttpExternalAudienceField(field: string): boolean {
  return HTTP_EXTERNAL_AUDIENCE_FIELDS.has(field)
    || /^(?:to|cc|bcc|recipient|signatory|channel|email|phone|customer|user)(?:s|_(?:id|ids|email|emails|address|addresses|number|numbers))?$/.test(field);
}

function resemblesUnknownExternalAudienceField(field: string): boolean {
  return /(?:^|_)(?:blind_?copy|copy_to|deliver_to|reply_to)(?:_|$)/.test(field)
    || /(?:^|_)(?:audience|channel|chat|conversation|contact|customer|destination|member|recipient|room|signatory|target|thread|user)(?:s)?_(?:address|addresses|email|emails|id|ids|number|numbers)$/.test(field)
    || /_(?:audience|channel|chat|destination|recipient|room|signatory|target|thread|to)(?:_id|_ids)?$/.test(field);
}

function isKnownHttpExternalSendNonAudienceField(field: string): boolean {
  return HTTP_EXTERNAL_SEND_NON_AUDIENCE_FIELDS.has(field);
}

function literalAudienceValues(value: unknown, field: string): { values: string[]; resolved: boolean } {
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

function literalConditionalValues(
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

function collectEmailsFromLiteral(
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

function collectConditionalTargetsFromHttpPath(
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

function parseHttpExternalSendPayload(
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

/**
 * Resolve every literal audience carried by a mutating HTTP send. Any opaque,
 * dynamic, file-backed, or malformed payload keeps an explicit unresolved
 * sentinel in the authorization boundary, including for loopback requests.
 */
function extractHttpExternalSendTargets(
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

function isLoopbackHost(host: string | undefined): boolean {
  return !!host && /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?$/i.test(host);
}

function mergeSensitiveShellActions(
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

function classifyBash(
  input: Record<string, unknown>,
  initialTargets: string[] = [],
  promptType: SensitiveExternalAction['promptType'] = 'bash',
  allowImplementationAliases = false,
): SensitiveExternalAction | null {
  const command = commandFromActionInput(input);
  if (!command) return null;

  const inspectWords = (rawWords: string[], inheritedTargets: string[] = []): SensitiveExternalAction[] => {
    const words = unwrapCommand(rawWords);
    if (words.length === 0) return [];
    const executable = basename(words[0]!);

    if (['ash', 'bash', 'dash', 'ksh', 'sh', 'zsh'].includes(executable)) {
      const commandFlagIndex = words.findIndex(word => word === '-c' || word === '-lc');
      const nested = commandFlagIndex >= 0 ? words[commandFlagIndex + 1] : undefined;
      return nested
        ? parseSimpleCommands(nested).flatMap(nestedWords => inspectWords(nestedWords, inheritedTargets))
        : [];
    }

    if (executable === 'eval') {
      const nested = words.slice(1).join(' ');
      if (!nested || /[$`]/.test(nested)) {
        return [makeAction(
          'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
          [['explicit eval execution']],
        )];
      }
      const nestedCommands = parseSimpleCommands(nested);
      if (nestedCommands.length === 0) {
        return [makeAction(
          'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
          [['explicit eval execution']],
        )];
      }
      return nestedCommands.flatMap(nestedWords => inspectWords(nestedWords, inheritedTargets));
    }

    if (executable === 'ssh') {
      const hostIndex = findSshHostIndex(words);
      const host = hostIndex >= 0 ? words[hostIndex] : undefined;
      const remoteCommand = hostIndex >= 0 ? words.slice(hostIndex + 1).join(' ') : '';
      if (remoteCommand) {
        const scopedTargets = extractRemoteCommandScopeTargets({ server: host, command: remoteCommand });
        const remoteTargets = uniqueTargets([
          ...inheritedTargets,
          host,
          ...(scopedTargets.length > 0 ? scopedTargets : [host]),
        ]);
        const nestedActions: SensitiveExternalAction[] = [];
        if (isRemoteInlineSecretWrite(remoteCommand)) {
          nestedActions.push(makeAction(
            'secret_transfer',
            promptType,
            redactCommandPreview(command, 'secret_transfer'),
            remoteTargets,
          ));
        }
        for (const nestedWords of parseSimpleCommands(remoteCommand)) {
          nestedActions.push(...inspectWords(nestedWords, remoteTargets));
        }
        return nestedActions;
      }
      return [];
    }

    if (executable === 'git' && words.some((word, index) =>
      (word === '-c' && /^alias\./i.test(words[index + 1] ?? ''))
      || /^--config=alias\./i.test(word)
    )) {
      return [makeAction(
        'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
        [['explicit git alias execution']],
      )];
    }

    const opaquePackageOperation = packageManagerExternalOperation(words);
    if (opaquePackageOperation) {
      return [makeAction(
        opaquePackageOperation,
        promptType,
        redactCommandPreview(command, opaquePackageOperation),
        uniqueTargets([...inheritedTargets, UNRESOLVED_EXTERNAL_TARGET]),
        opaquePackageOperation === 'external_mutation'
          ? [['execute external package command']]
          : undefined,
      )];
    }

    const gitPush = getGitPush(words);
    if (gitPush) {
      return [makeAction('git_push', promptType, redactCommandPreview(command, 'git_push'), uniqueTargets([...inheritedTargets, ...gitPush.targets]))];
    }

    const deployment = classifyDeployment(words);
    if (deployment) {
      return [makeAction('deployment', promptType, redactCommandPreview(command, 'deployment'), uniqueTargets([...inheritedTargets, ...deployment.targets]))];
    }

    const restart = classifyRestart(words);
    if (restart) {
      return [makeAction(
        'service_restart',
        promptType,
        redactCommandPreview(command, 'service_restart'),
        uniqueTargets([...inheritedTargets, ...restart.targets]),
        promptType === 'mcp_mutation' && allowImplementationAliases
          ? REMOTE_SERVICE_LIFECYCLE_AUTHORIZATION_TERMS
          : undefined,
      )];
    }

    const secretTargets = classifySecretWrite(words, command);
    if (secretTargets) {
      return [makeAction('secret_transfer', promptType, redactCommandPreview(command, 'secret_transfer'), uniqueTargets([...inheritedTargets, ...secretTargets]))];
    }

    const paymentTargets = classifyPaymentCli(words);
    if (paymentTargets) {
      return [makeAction('payment', promptType, redactCommandPreview(command, 'payment'),
        uniqueTargets([...inheritedTargets, ...paymentTargets]))];
    }

    const http = classifyHttpMutation(words);
    if (http) {
      const category = httpMutationCategory(http);
      const externalSendTargets = category === 'external_send'
        ? extractHttpExternalSendTargets(words, command)
        : undefined;
      const businessTargets = externalSendTargets?.audienceTargets
        ?? extractLiteralBusinessTargets(command);
      const loopback = inheritedTargets.length > 0 && isLoopbackHost(http.host);
      const boundedLoopbackImplementation = loopback && allowImplementationAliases
        && !!stringInput(input, ['cwd', 'workingDirectory', 'working_directory'])
        && !inheritedTargets.includes(UNRESOLVED_REMOTE_SCOPE);
      const targets = uniqueTargets([
        ...inheritedTargets,
        ...(loopback ? [] : http.targets),
        ...businessTargets,
      ]);
      return [makeAction(
        category,
        promptType,
        redactCommandPreview(command, category),
        targets,
        category === 'external_mutation'
          ? [uniqueTargets([
            ...genericMutationAuthorizationTerms(http.method.toLowerCase())[0]!,
            ...(boundedLoopbackImplementation ? IN_SCOPE_IMPLEMENTATION_ALIASES : []),
          ])]
          : undefined,
        externalSendTargets?.conditionalTargets,
      )];
    }

    // Local destructive commands remain governed by the permission mode and
    // shell guard. This classifier adds the stricter action+target boundary
    // only when the same command mutates an already identified remote scope.
    if (inheritedTargets.length > 0 && ['rm', 'rmdir', 'unlink', 'shred'].includes(executable)) {
      return [makeAction(
        'external_mutation',
        promptType,
        redactCommandPreview(command, 'external_mutation'),
        inheritedTargets,
        genericMutationAuthorizationTerms('delete'),
      )];
    }

    return [];
  };

  const actions: SensitiveExternalAction[] = [];
  if (promptType === 'mcp_mutation' && isRemoteInlineSecretWrite(command)) {
    actions.push(makeAction(
      'secret_transfer', promptType, redactCommandPreview(command, 'secret_transfer'), initialTargets,
    ));
  }
  const parsedCommands = parseSimpleCommands(command);
  if (parsedCommands.length === 0 && (promptType === 'mcp_mutation'
    || /(?:^|[\s;&|()])(?:curl|wget|http|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|git|gh|kubectl|helm|terraform|ansible|systemctl|service|docker|podman|deploy|publish|send|mail)(?:$|[\s;&|()])/i.test(command))) {
    actions.push(makeAction(
      'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'),
      uniqueTargets([...initialTargets, UNRESOLVED_EXTERNAL_TARGET]),
      [['unparsed potentially sensitive shell command']],
    ));
  }
  for (const words of parsedCommands) {
    actions.push(...inspectWords(words, initialTargets));
  }
  return mergeSensitiveShellActions(actions, command, promptType);
}

function normalizedToolAction(toolName: string): string {
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
const GMAIL_SEND_TOOL = 'mcp__google-contacts__gmail_send';
const BOUNDED_OSS_ATOMIC_WRITE_TOOL = 'mcp__rbw-agents-oss__oss_write_file';
const BOUNDED_OSS_ATOMIC_WRITE_ROOT = '/srv/rbw-agents-oss/scripts';
const GRAPH_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ATRIA_APP_CONSENT_APPROVAL_ENDPOINT = new RegExp(
  `^identityGovernance/appConsent/appConsentRequests/(${GRAPH_UUID})/userConsentRequests/(${GRAPH_UUID})/approval/stages/(${GRAPH_UUID})$`,
  'i',
);
const ATRIA_APP_CONSENT_APPROVAL_TERMS = [[
  'approve', 'approves', 'approved', 'approval', 'approuve', 'approuver', 'approuvez',
  'validate', 'validates', 'validated', 'valide', 'valider', 'validez',
]];

function safePermissionPromptValue(value: unknown, fallback: string): string {
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

function classifyMcp(
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

function classifyApi(toolName: string, input: Record<string, unknown>): SensitiveExternalAction | null {
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

/** Classify only high-confidence external mutations; ordinary local/read actions return null. */
const BOUNDED_REMOTE_HOST_PROMPT_TOOLS = new Set([
  'mcp__rbw-servers__ssh_execute',
  'mcp__rbw-servers__ssh_execute_sudo',
]);

function literalCanonicalAbsolutePosixPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 2 || value.length > 512
    || !posix.isAbsolute(value) || posix.normalize(value) !== value
    || value.includes('\\') || hasDynamicOrGlobTargetSyntax(value)) return undefined;
  const components = value.slice(1).split('/');
  if (components.some(component => component === '.' || component === '..'
    || !/^[A-Za-z0-9._@%+=:,() -]+$/u.test(component))) return undefined;
  return value;
}

function boundedOssAtomicWriteLiteralPath(value: unknown): string | undefined {
  const path = literalCanonicalAbsolutePosixPath(value);
  if (!path || !path.startsWith(`${BOUNDED_OSS_ATOMIC_WRITE_ROOT}/`)) return undefined;
  const relativePath = path.slice(BOUNDED_OSS_ATOMIC_WRITE_ROOT.length + 1);
  if (isSensitiveRemoteTransferSource({ localPath: `/${relativePath}` })) {
    return undefined;
  }
  return path;
}

function boundedOssAtomicWritePath(
  input: Record<string, unknown>,
): string | undefined {
  const path = boundedOssAtomicWriteLiteralPath(input.path);
  if (!path || typeof input.content !== 'string'
    || input.content.length === 0
    || input.content.length > 1_000_000
    || input.content.includes('\0')
    || Object.keys(input).some(key => ![
      'path', 'content', '_displayName', '_intent',
    ].includes(key))) return undefined;
  const validMetadata = ['_displayName', '_intent'].every(key => {
    const value = input[key];
    return value === undefined || typeof value === 'string'
      && value.length <= 1_000
      && !/[\0\r\n]/u.test(value);
  });
  return validMetadata ? path : undefined;
}

export function classifySensitiveExternalAction(
  toolName: string,
  input: Record<string, unknown>,
): SensitiveExternalAction | null {
  if (toolName === 'Bash') return classifyBash(input);
  if (/(?:^|__)(?:ssh_(?:execute|exec)(?:_sudo)?|remote_(?:execute|exec)|run_command)$/i.test(toolName)) {
    const boundedRemoteHostPrompt = BOUNDED_REMOTE_HOST_PROMPT_TOOLS.has(toolName);
    const targets = boundedRemoteHostPrompt
      ? extractRemoteCommandScopeTargets(input)
      : [UNRESOLVED_REMOTE_SCOPE];
    const action = classifyBash(input, targets, 'mcp_mutation', true)
      ?? classifyMcp(toolName, input, targets, true);
    const failClosedAction = action ?? (!boundedRemoteHostPrompt && commandFromActionInput(input)
      ? makeAction(
        'external_mutation',
        'mcp_mutation',
        redactCommandPreview(commandFromActionInput(input), 'external_mutation'),
        targets,
      )
      : null);
    if (!failClosedAction) return null;
    const remoteCommand = commandFromActionInput(input);
    const uniqueBoundedRemoteCommand = boundedRemoteHostPrompt
      && typeof input.command === 'string' && input.command === remoteCommand
      && !['cmd', 'script'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? remoteCommand : undefined;
    const boundedRemoteCommandAliasAmbiguity = boundedRemoteHostPrompt
      && ['cmd', 'script'].some(key => Object.prototype.hasOwnProperty.call(input, key));
    const literalBoundedEndpoint = boundedRemoteHostPrompt
      && typeof input.server === 'string'
      && input.server === input.server.trim()
      && input.server.length > 0 && input.server.length <= 256
      && /^[A-Za-z0-9._@:-]+$/u.test(input.server)
      && !['host', 'hostname'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? input.server : undefined;
    const literalBoundedCwd = boundedRemoteHostPrompt
      && typeof input.cwd === 'string'
      && literalCanonicalAbsolutePosixPath(input.cwd)
      && !['workingDirectory', 'working_directory'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? input.cwd : undefined;
    const connectorFallbackNeedsCommandPreview = failClosedAction.commandPreview === toolName;
    return {
      ...failClosedAction,
      // A connector-shaped fallback previously displayed only the MCP tool
      // name, making exact host confirmation impossible. Always surface the
      // bounded command itself while preserving category-aware redaction.
      ...(remoteCommand && connectorFallbackNeedsCommandPreview
        ? {
          commandPreview: redactCommandPreview(remoteCommand, failClosedAction.category),
        }
        : {}),
      description: `${failClosedAction.description} Tool: ${toolName}.`,
      remoteCommand: true,
      ...(boundedRemoteHostPrompt
        ? { boundedRemoteHostPrompt: true as const }
        : {}),
      ...(literalBoundedEndpoint ? { boundedRemoteEndpoint: literalBoundedEndpoint } : {}),
      ...(literalBoundedCwd ? { boundedRemoteWorkingDirectory: literalBoundedCwd } : {}),
      ...(boundedRemoteCommandAliasAmbiguity
        || uniqueBoundedRemoteCommand && boundedRemoteReadHasHiddenSideEffect(uniqueBoundedRemoteCommand)
        ? { boundedRemoteReadSideEffect: true as const }
        : {}),
      ...(literalBoundedEndpoint && literalBoundedCwd && uniqueBoundedRemoteCommand
        && isBoundedRemoteImplementationLifecycleCommand(uniqueBoundedRemoteCommand, literalBoundedCwd)
        ? { boundedRemoteImplementationLifecycle: true as const }
        : {}),
    };
  }
  if (toolName.startsWith('mcp__')) {
    if (toolName === BOUNDED_OSS_ATOMIC_WRITE_TOOL) {
      const classified = classifyMcp(toolName, input);
      const path = boundedOssAtomicWritePath(input);
      if (!classified || !path) return classified;
      return {
        ...classified,
        targetCandidates: [path],
        boundedOssAtomicWrite: true,
      };
    }
    const action = normalizedToolAction(toolName.split('__').slice(2).join('_'));
    const remoteTransfer = /(?:^|_)(?:ssh|remote)_(?:upload|copy|write|put)(?:_|$)/.test(action);
    const classified = classifyMcp(
      toolName,
      input,
      remoteTransfer ? extractRemoteTransferScopeTargets(input) : undefined,
      remoteTransfer,
    );
    if (!remoteTransfer || !classified) return classified;
    const category = isSensitiveRemoteTransferSource(input)
      ? 'secret_transfer' as const
      : classified.category;
    const boundedRemoteTransfer = toolName === 'mcp__rbw-servers__ssh_upload';
    return {
      ...classified,
      category,
      commandPreview: remoteTransferPermissionPreview(toolName, input),
      description: ACTION_DETAILS[category].description,
      authorizationTermGroups: category === 'external_mutation'
        ? [[...new Set([
          ...ACTION_DETAILS.external_mutation.authorizationTermGroups[0]!,
          ...IN_SCOPE_IMPLEMENTATION_ALIASES,
        ])]]
        : ACTION_DETAILS[category].authorizationTermGroups,
      ...(boundedRemoteTransfer ? { boundedRemoteHostPrompt: true as const } : {}),
    };
  }
  if (toolName.startsWith('api_')) return classifyApi(toolName, input);
  return null;
}

function containsPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeForMatch(phrase);
  return normalizedPhrase.length > 0 && ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function containsNonNegatedPhrase(normalizedText: string, phrase: string): boolean {
  const phraseTokens = normalizeForMatch(phrase).split(' ').filter(Boolean);
  const textTokens = normalizedText.split(' ').filter(Boolean);
  if (phraseTokens.length === 0 || textTokens.length < phraseTokens.length) return false;
  for (let index = 0; index <= textTokens.length - phraseTokens.length; index += 1) {
    if (!phraseTokens.every((token, offset) => textTokens[index + offset] === token)) continue;
    const before = textTokens.slice(Math.max(0, index - 4), index);
    const after = textTokens.slice(index + phraseTokens.length, index + phraseTokens.length + 3);
    const beforeText = before.join(' ');
    const directlyNegated = /(?:^|\s)(?:aucun|aucune|jamais|never|no|not|pas|pas de|sans(?: (?:aucun|aucune|un|une))?|without(?: (?:a|any))?)$/.test(beforeText)
      || before.slice(-2).join(' ') === 'don t';
    const frenchWrappedNegation = before.some(token => token === 'ne' || token === 'n')
      && after.some(token => ['jamais', 'pas', 'plus'].includes(token));
    if (!directlyNegated && !frenchWrappedNegation) return true;
  }
  return false;
}

function targetIsNamed(rawRequest: string, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  const escaped = trimmed
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|[-_.]+)');
  // Keep structured punctuation inside the token boundary. This rejects
  // api.example.com.evil, alice@example.com.evil, widgets-fork and
  // main-backup while still allowing prose around the exact target.
  return new RegExp(
    `(?:^|[\\s/([{\"'“,:;])${escaped}(?=$|\\s|[)\\]}\"'”,;!?]|[.:](?=$|\\s))`,
    'iu',
  ).test(rawRequest);
}

function requestClauses(rawRequest: string): string[] {
  return rawRequest
    .split(/(?:[!?;]+|\.(?=\s|$)|[\r\n]+)/u)
    .map(clause => clause.trim())
    .filter(Boolean);
}

/** A target mention is authority only when the local clause does not exclude it. */
function targetIsNegatedInClause(rawClause: string, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return true;
  const escaped = trimmed
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|[-_.]+)');
  const expression = new RegExp(
    `(?:^|[\\s/([{"'“,:;])(${escaped})(?=$|\\s|[)\\]}"'”,;!?]|[.:](?=$|\\s))`,
    'giu',
  );
  for (const match of rawClause.matchAll(expression)) {
    const targetStart = (match.index ?? 0) + match[0].lastIndexOf(match[1]!);
    const before = normalizeForMatch(rawClause.slice(Math.max(0, targetStart - 120), targetStart));
    const after = normalizeForMatch(rawClause.slice(targetStart + match[1]!.length, targetStart + match[1]!.length + 120));
    const clause = normalizeForMatch(rawClause);
    const excludedBefore = /(?:^|\s)(?:pas|non|not|never|jamais|sauf|sans|except|excluding|exclude|excludes|excluded|exclure|exclus|exclue|hors|without)(?:\s+(?:only|uniquement|seulement))?(?:\s+(?:a|to|pour|for|de))?(?:\s+(?:le|la|les|l|the|un|une))?(?:\s+(?:contrat|contract|document|envelope|enveloppe|recipient|destinataire|cible|target))?\s*$/.test(before)
      || /(?:^|\s)(?:a l exception de|a l exclusion de|rather than|instead of|plutot que|plutot de)\s*$/.test(before)
      || /(?:^|\s)(?:ne|n)\s+(?:envoie|adresse|transmet|transfere|paie|paye|publie|deploie|redemarre|inclue|inclus|send|email|notify|transfer|pay|publish|deploy|restart|include)\w*\s+pas(?:\s+(?:a|to|pour|vers))?\s*$/.test(before)
      || /(?:^|\s)(?:do not|don t|never)\s+(?:send|email|notify|address|deliver|transfer|pay|publish|deploy|restart|include)(?:\s+(?:to|on|into))?\s*$/.test(before);
    const excludedAfter = /^(?:\s)*(?:(?:n|ne)\s+(?:est|reste)\s+pas\s+(?:autorise|autorisee)|(?:is|are)\s+not\s+(?:allowed|authorized)|(?:(?:est|reste|is|remains)\s+)?(?:strictement\s+)?(?:interdit|interdite|interdits|interdites|forbidden|excluded|exclu|exclue))\b/.test(after);
    const excludedAround = /(?:^|\s)(?:leave|omit|laisse|laisser)\s*$/.test(before)
      && /^(?:out|de cote|excluded|exclu|exclue)\b/.test(after);
    const negativeClause = /^(?:pas|jamais|never|not|sauf|sans|except|excluding|without)\b/.test(clause);
    if (!excludedBefore && !excludedAfter && !excludedAround && !negativeClause) return false;
  }
  return true;
}

function authorizingRequestClauses(
  action: SensitiveExternalAction,
  rawRequest: string,
): string[] {
  return requestClauses(rawRequest).filter(clause => (
    requestNamesSensitiveAction(action, normalizeForMatch(clause))
  ));
}

const CONDITIONAL_TARGET_TERMS: Readonly<Record<SensitiveConditionalTargetKind, readonly string[]>> = {
  contract: ['contract', 'contrat'],
  document: ['document'],
  envelope: ['envelope', 'enveloppe'],
};

function explicitConditionalTargetValues(
  rawRequest: string,
  kind: SensitiveConditionalTargetKind,
): string[] {
  const comparableRequest = rawRequest
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const terms = CONDITIONAL_TARGET_TERMS[kind].join('|');
  const values: string[] = [];
  const expression = new RegExp(
    `\\b(?:${terms})\\b\\s*(?:(?:[_-]?id|number|numero|no|n[°º]?)\\s*[:=#-]?\\s*([a-z0-9][a-z0-9._:-]*)|[:=#]\\s*([a-z0-9][a-z0-9._:-]*)|([a-z0-9._:-]*[0-9][a-z0-9._:-]*))`,
    'giu',
  );
  for (const match of comparableRequest.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.push(value);
  }
  return [...new Set(values)];
}

function requestMatchesConditionalTargets(
  action: SensitiveExternalAction,
  rawRequest: string,
): boolean {
  const conditionalTargets = action.conditionalTargetCandidates ?? [];
  const clauses = authorizingRequestClauses(action, rawRequest);
  for (const kind of ['contract', 'document', 'envelope'] as const) {
    const allExplicitValues = explicitConditionalTargetValues(rawRequest, kind);
    if (allExplicitValues.length === 0) continue;
    const explicitValues = [...new Set(clauses.flatMap(clause => (
      explicitConditionalTargetValues(clause, kind)
        .filter(value => !targetIsNegatedInClause(clause, value))
    )))];
    const payloadValues = conditionalTargets
      .filter(candidate => candidate.kind === kind)
      .map(candidate => candidate.value.toLowerCase());
    // Once the user binds an operation to a typed object ID, the concrete
    // request must expose that same kind of ID. Absence is not proof of a
    // match, and every ID carried by the payload/URL must stay within the
    // explicitly authorized set.
    if (payloadValues.length === 0
      || payloadValues.some(value => !explicitValues.includes(value))) return false;
  }
  return true;
}

function requestHasExplicitConditionalTarget(rawRequest: string): boolean {
  return (['contract', 'document', 'envelope'] as const)
    .some(kind => explicitConditionalTargetValues(rawRequest, kind).length > 0);
}

function isNonAuthorizingRequest(rawRequest: string, normalizedRequest: string): boolean {
  if (/[?？]/.test(rawRequest)) return true;

  const withoutPoliteness = normalizedRequest.replace(
    /^(?:please|s il te plait|s il vous plait|merci de)\s+/,
    '',
  );
  return NON_AUTHORIZING_QUESTION_PREFIX.test(withoutPoliteness)
    || NON_AUTHORIZING_INFORMATION_PREFIX.test(withoutPoliteness)
    || /\b(?:how to|comment faire|instructions? (?:to|pour))\b/.test(withoutPoliteness);
}

function requestNamesSensitiveAction(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  return (action.authorizationTermGroups ?? ACTION_DETAILS[action.category].authorizationTermGroups).every(group =>
    group.some(term => containsNonNegatedPhrase(normalizedRequest, term))
  );
}

function requestMentionsSensitiveAction(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  return (action.authorizationTermGroups ?? ACTION_DETAILS[action.category].authorizationTermGroups).every(group =>
    group.some(term => containsPhrase(normalizedRequest, term))
  );
}

function requestNamesSensitiveActionCategory(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  if (action.category !== 'external_mutation') {
    return requestMentionsSensitiveAction(action, normalizedRequest);
  }
  return requestMentionsSensitiveAction(action, normalizedRequest)
    || Object.values(GENERIC_MUTATION_TERM_ALIASES).some(terms =>
    terms.some(term => containsPhrase(normalizedRequest, term))
  ) || ACTION_DETAILS.external_mutation.authorizationTermGroups.some(terms =>
    terms.some(term => containsPhrase(normalizedRequest, term))
  );
}

const RETARGETING_MARKER = /\b(?:actually|change|changed|correction|correct|finally|finalement|instead|plutot|rather|replace|remplace|wrong)\b/;
const TARGET_FIELD_RETARGET = /\b(?:account|audience|branch|canal|channel|cible|compte|contract|contrat|customer|destinataire|destination|document|envelope|enveloppe|environment|environnement|host|merchant|org|organization|recipient|remote|repo|repository|service|target|team)\b/;
const DEICTIC_RETARGET = /\b(?:actually|finally|finalement)\s+(?:a|dans|pour|sur|to|vers)\s+(?:le |la |l |the )?[a-z0-9][a-z0-9._/@:-]*\b/;
const ALTERNATIVE_RETARGET = /\b(?:a|dans|pour|sur|to|vers)\s+(?:le |la |l |the )?[a-z0-9][a-z0-9._/@:-]*(?:\s+[a-z0-9._/@:-]+){0,2}\s+(?:instead|plutot|rather)\b/;

/**
 * A terse amendment may change only the target ("Actually, to Bob instead")
 * without repeating the action verb. It must still own the authority boundary:
 * otherwise an older action+target authorization can incorrectly survive.
 */
function requestExplicitlyRetargets(
  action: SensitiveExternalAction,
  rawRequest: string,
  normalizedRequest: string,
): boolean {
  const hasStructuredTarget = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(rawRequest)
    || /https?:\/\/[^\s]+/i.test(rawRequest)
    || /(?:^|\s)@[A-Za-z0-9_.-]+\b/.test(rawRequest)
    || requestHasExplicitConditionalTarget(rawRequest);
  const explicitlyExcludedTarget = action.targetCandidates.some(target => (
    targetIsNamed(rawRequest, target) && targetIsNegatedInClause(rawRequest, target)
  )) || requestHasExplicitConditionalTarget(rawRequest)
    && /\b(?:interdit|interdite|forbidden|pas|sauf|sans|except|excluding|without)\b/.test(normalizedRequest);
  if (explicitlyExcludedTarget) return true;
  if (hasStructuredTarget
    && /^(?:(?:contract|contrat|document|envelope|enveloppe|recipient|destinataire|to|a|use|utilise)(?:\s+final)?\b)/.test(normalizedRequest)) {
    const structuredActionTargets = action.targetCandidates.filter(target => /[@/:.]/.test(target));
    if (requestHasExplicitConditionalTarget(rawRequest)) return true;
    return !structuredActionTargets.some(target => targetIsNamed(rawRequest, target));
  }
  if (/^[a-z0-9._/@:-]+(?:\s+[a-z0-9._/@:-]+){0,2}\s+(?:instead|plutot)$/.test(normalizedRequest)) {
    return true;
  }
  if (!RETARGETING_MARKER.test(normalizedRequest)) return false;
  if (hasStructuredTarget) return true;
  return TARGET_FIELD_RETARGET.test(normalizedRequest)
    || DEICTIC_RETARGET.test(normalizedRequest)
    || ALTERNATIVE_RETARGET.test(normalizedRequest);
}

const OBJECTIVE_EMAIL_ADDRESS_SOURCE = String.raw`[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}`;

/** Resolve only the explicit requester of a direct invoice-email fulfillment
 * delegation. This is intentionally not a generic reported-speech rule: it
 * requires a top-level handling order, an embedded resend request, invoice +
 * PDF + email scope, and a uniquely recoverable sender address. */
function directInvoiceEmailFulfillmentRequester(rawRequest: string): string | undefined {
  if (!rawRequest.trim() || rawRequest.length > 4_000) return undefined;
  const normalized = normalizeForMatch(rawRequest);
  const directHandling = /^(?:(?:merci de|please)\s+)?(?:traite|traitez|traiter|prends?\s+en\s+charge|prenez\s+en\s+charge|prendre\s+en\s+charge|occupe\s+toi\s+de|occupez\s+vous\s+de|handle|process|fulfil|fulfill)\b/u.test(normalized);
  const embeddedResendRequest = /\b(?:(?:qui\s+)?(?:demande|demandant)\s+(?:de\s+|le\s+)?(?:renvoi|renvoie|renvoyer|reexpedition|reexpedie|reexpedier)|(?:asks?|asking|request(?:s|ed|ing)?)\s+(?:you\s+)?(?:to\s+)?(?:resend|send\s+(?:it\s+)?again))\b/u.test(normalized);
  const invoicePdfEmail = /\b(?:facture|invoice)\b/u.test(normalized)
    && /\bpdf\b/u.test(normalized)
    && /\b(?:e\s+mail|email|mail)\b/u.test(normalized);
  const explicitRevocation = /\b(?:(?:ne|n)\s+(?:(?:la|le|les|lui)\s+)?(?:renvoie|reexpedie|envoie|transmets)\b[^.!?;]{0,80}\b(?:pas|plus|rien|jamais)|(?:do\s+not|dont|never)\s+(?:resend|send|forward)|sans\s+(?:renvoi|renvoyer|envoi|envoyer)|without\s+(?:resending|sending|forwarding))\b/u.test(normalized);
  if (!directHandling || !embeddedResendRequest || !invoicePdfEmail || explicitRevocation) {
    return undefined;
  }

  const labelledSender = new RegExp(
    String.raw`(?:^|[\r\n])\s*(?:from|de|exp[ée]diteur)\s*:\s*(?:[^\r\n<>]{0,120}<)?(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>?\s*$`,
    'imu',
  ).exec(rawRequest)?.[1];
  const pastedSender = new RegExp(
    String.raw`(?:^|[\r\n])[^\r\n<>]{1,160}<(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>[^\r\n]*\r?\n(?:[^\r\n]*\r?\n){0,3}\s*(?:[ÀA]|To)\s+(?:[^\r\n]*<)?${OBJECTIVE_EMAIL_ADDRESS_SOURCE}>?`,
    'imu',
  ).exec(rawRequest)?.[1];
  const inlineSender = new RegExp(
    String.raw`\b(?:from|de\s+la\s+part\s+de|exp[ée]diteur)\s+(?:[^\r\n<>]{0,100}<)?(${OBJECTIVE_EMAIL_ADDRESS_SOURCE})>?`,
    'iu',
  ).exec(rawRequest)?.[1];
  const captured = labelledSender ?? pastedSender ?? inlineSender;
  if (captured) return captured.toLowerCase();

  const allEmails = [...rawRequest.matchAll(new RegExp(OBJECTIVE_EMAIL_ADDRESS_SOURCE, 'giu'))]
    .map(match => match[0]!.toLowerCase());
  const uniqueEmails = [...new Set(allEmails)];
  return uniqueEmails.length === 1 ? uniqueEmails[0] : undefined;
}

/**
 * A current user request authorizes the action only when it explicitly names
 * both the action category and a concrete target/audience derived from the
 * tool call. Generic continuations never count as authorization.
 */
export function isSensitiveExternalActionExplicitlyAuthorized(
  action: SensitiveExternalAction,
  currentUserRequest?: string,
): boolean {
  const rawRequest = structuredGmailPolicyRequest(currentUserRequest ?? '');
  const normalizedRequest = normalizeForMatch(rawRequest);
  if (
    !normalizedRequest
    || isTargetFreeGenericContinuation(normalizedRequest)
    || isNonAuthorizingRequest(rawRequest, normalizedRequest)
  ) return false;

  const delegatedInvoiceRequester = directInvoiceEmailFulfillmentRequester(rawRequest);
  if (delegatedInvoiceRequester !== undefined) {
    return action.category === 'external_send'
      && action.boundedSessionPdfAttachment === true
      && action.targetCandidates.length === 1
      && action.targetCandidates[0]?.toLowerCase() === delegatedInvoiceRequester;
  }

  // A bounded session PDF is still content disclosure. Generic send authority
  // is sufficient only when the same authenticated request explicitly names
  // the invoice PDF deliverable; otherwise the attachment remains blocked.
  if (action.boundedSessionPdfAttachment
    && !(/\b(?:facture|invoice)\b/u.test(normalizedRequest)
      && /\bpdf\b/u.test(normalizedRequest))) return false;

  const actionNamed = requestNamesSensitiveAction(action, normalizedRequest);
  if (!actionNamed || action.targetCandidates.length === 0) return false;
  if (action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;
  if (!requestMatchesConditionalTargets(action, rawRequest)) return false;

  // A later prohibition in the same user turn revokes an earlier positive
  // sentence. Never authorize by cherry-picking only the positive clause.
  const allClauses = requestClauses(rawRequest);
  const allConditionalTargets = (action.conditionalTargetCandidates ?? [])
    .map(candidate => candidate.value);
  if ([...action.targetCandidates, ...allConditionalTargets].some(target =>
    allClauses.some(clause => targetIsNamed(clause, target)
      && targetIsNegatedInClause(clause, target))
  )) return false;

  // Every concrete recipient/remote/account extracted from the call is part of
  // its authority boundary. Naming one `to` address must never authorize an
  // additional CC/BCC recipient or a different nested remote target.
  const clauses = authorizingRequestClauses(action, rawRequest);
  return action.targetCandidates.every(target => clauses.some(clause => (
    targetIsNamed(clause, target) && !targetIsNegatedInClause(clause, target)
  )));
}

const EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION = /\b(?:wait|attends?|attendez|arrete(?:z)?(?:\s+toi)?|stop)\b[^.!?;\n]{0,140}\b(?:before|avant)\b[^.!?;\n]{0,100}\b(?:send|sending|publish|deploy|restart|payment|envoi|envoyer|publication|deploiement|redemarrage|paiement)\b/u;
const EXPLICIT_ACTION_AFTER_CONFIRMATION = /(?:^|[.!?;]\s*)\b(?:after|apres)\s+(?:the\s+|la\s+)?(?:confirmation|approval|autorisation)\b\s*[,:-]?\s*(?:send|publish|deploy|restart|pay|envoie|envoyer|publie|publier|deploie|deployer|redemarre|redemarrer|paie|payer)\b/u;
const GLOBAL_EXTERNAL_ACTION_REVOCATION_CORE = /^(?:non|no|actually\s+no|finalement\s+non|n\s+y\s+va\s+pas|ne\s+continue\s+pas|(?:(?:non|no)\s+)?(?:(?:actually|finalement)\s+)?(?:abort|annule|annuler|arrete(?:z)?(?:\s+toi)?|cancel|do not do it|do nothing|dont do it|forget it|laisse tomber|ne fais(?:\s+surtout)?\s+rien|ne le fais pas|never mind|oublie ca|stop)(?:\s+(?:ca|cela|this|that))?)$/u;
const EXTERNAL_ACTION_REVOCATION_POLITENESS_PREFIX = /^(?:please|s il te plait|s il vous plait|stp|svp)\s+/u;
const EXTERNAL_ACTION_REVOCATION_SUFFIX = /\s+(?:immediately|immediatement|maintenant|now|please|s il te plait|s il vous plait|stp|svp|tout de suite)$/u;
const GENERIC_EXTERNAL_CONFIRMATION_CONTINUATION = /^(?:(?:ok|oui|yes)\s+)?(?:send|envoi|envoie|envoyer|transmets?|transmettre)(?:\s+(?:it|la|le))?$/u;
const TARGETED_EXTERNAL_CONFIRMATION_CONTINUATION = /^(?:(?:ok|oui|yes)\s+)?(?:send|envoi|envoie|envoyer|transmets?|transmettre)\s+(?:(?:the|le|la|l)\s+)?(?:(?:(?:e\s+)?mail|email|invitation|message)\s+)?(?:to|a|vers)\s+([a-z0-9][a-z0-9-]*)$/u;

/** A short answer such as “Envoyer maintenant” is not execution authority.
 * It may only resume an older exact stop-before-action contract so the host can
 * display its scoped prompt. An optional human alias is checked against that
 * same target-bearing objective segment before the boundary is accepted. */
function externalConfirmationContinuationAlias(
  normalizedRequest: string,
): { matched: true; alias?: string } | undefined {
  const withoutTemporalSuffix = normalizedRequest.replace(/\s+(?:maintenant|now)$/, '');
  if (GENERIC_EXTERNAL_CONFIRMATION_CONTINUATION.test(withoutTemporalSuffix)) {
    return { matched: true };
  }
  const match = TARGETED_EXTERNAL_CONFIRMATION_CONTINUATION.exec(withoutTemporalSuffix);
  const alias = match?.[1]?.trim();
  if (!alias) return undefined;
  return alias ? { matched: true, alias } : { matched: true };
}

function hasGlobalExternalActionRevocation(rawRequest: string): boolean {
  return requestClauses(rawRequest).some(rawClause => {
    let clause = normalizeForMatch(rawClause)
      .replace(EXTERNAL_ACTION_REVOCATION_POLITENESS_PREFIX, '');
    let previous = '';
    while (clause !== previous) {
      previous = clause;
      clause = clause.replace(EXTERNAL_ACTION_REVOCATION_SUFFIX, '');
    }
    return GLOBAL_EXTERNAL_ACTION_REVOCATION_CORE.test(clause);
  });
}

export interface StructuredGmailSendResumePayload {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachmentPaths: string[];
}

export type StructuredGmailSendAuthorizationDecision =
  | 'not-applicable'
  | 'invalid'
  | 'authorized';

/** Fixed, non-sensitive reasons why a structured Gmail payload was rejected.
 * These labels intentionally never contain tool input or objective values. */
export type StructuredGmailSendMismatchCategory =
  | 'authenticated-contract-unavailable'
  | 'authorization-boundary'
  | 'unexpected-from'
  | 'unexpected-replyTo'
  | 'unknown-fields'
  | 'to'
  | 'sendAsEmail'
  | 'subject'
  | 'body'
  | 'isHtml'
  | 'attachmentPaths'
  | 'cc'
  | 'bcc'
  | 'optional-guard-types'
  | 'metadata-types';

export interface StructuredGmailSendAuthorizationDiagnostic {
  decision: StructuredGmailSendAuthorizationDecision;
  mismatchCategories: readonly StructuredGmailSendMismatchCategory[];
}

const STRUCTURED_GMAIL_SEND_MARKER = /^\[robb-resume:[A-Za-z0-9][A-Za-z0-9:._-]{1,300}\]$/gmu;
const STRUCTURED_GMAIL_SEND_PAYLOAD_HEADER = /^(?:Payload autoris(?:e|é)|Authorized payload)[ \t]*:[ \t]*$/gimu;
const STRUCTURED_GMAIL_SEND_DIRECT_IMPERATIVE = /\b(?:envoie|envoyez|envoyer|execute|executez|executer|effectue|effectuez|effectuer|realise|realisez|realiser|procede|procedez|proceder|send|execute|perform|dispatch|deliver)\b[^.!?;\n]{0,240}\b(?:e mail|email|gmail|mail|message|envoi|send|sending)\b/u;
const STRUCTURED_GMAIL_SEND_NO_SEND_DIRECTIVE = /\b(?:(?:n|ne)\s+(?:envoie|envoyez|envoyer|transmets|transmettez|transmettre|expedie|expediez|expedier)\s+(?:rien|pas|plus)|(?:do\s+not|don\s+t|never)\s+(?:send|deliver|dispatch|transmit)|sans\s+(?:envoyer|envoi|transmettre)|without\s+(?:sending|delivery|dispatch))\b/u;
const STRUCTURED_GMAIL_SEND_SAFE_ABSENCE_GUARD = /^(?:si|seulement\s+si|if|only\s+if)\b[^.!?;\n]{0,260}\b(?:ambiguite|ambiguous|candidate|draft|brouillon|duplicate|doublon|pagination|sent)\b/u;
const STRUCTURED_GMAIL_SEND_RETARGET = /\b(?:autre\s+(?:destinataire|recipient)|change\s+(?:le\s+)?destinataire|different\s+recipient|instead|mauvais\s+destinataire|plutot|rather|retarget|wrong\s+recipient)\b/u;

function exactlyOneStructuredField(
  text: string,
  pattern: RegExp,
): RegExpMatchArray | undefined {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (match[1] !== undefined) match[1] = match[1].trim();
  return match;
}

function structuredGmailSendAttachmentPaths(value: string): string[] | undefined {
  if (value === '[]') return [];
  const match = /^\[([^\[\],\r\n]+)\]$/u.exec(value);
  const path = match?.[1];
  return isBoundedSessionPdfAttachmentPath(path) ? [path] : undefined;
}

/** Parse one authenticated restart segment as a closed Gmail send contract.
 *
 * The body is isolated before directive analysis: questions, email addresses,
 * or quoted instructions inside BODY_BEGIN/BODY_END are payload data only.
 * Every authority-bearing label remains single, literal, and outside the body.
 */
export function parseStructuredGmailSendResumeSegment(
  segment: string,
): StructuredGmailSendResumePayload | undefined {
  if (typeof segment !== 'string' || /\0/u.test(segment)) return undefined;
  const marker = exactlyOneStructuredField(segment, STRUCTURED_GMAIL_SEND_MARKER);
  const payloadHeader = exactlyOneStructuredField(segment, STRUCTURED_GMAIL_SEND_PAYLOAD_HEADER);
  const bodyBegin = exactlyOneStructuredField(segment, /^BODY_BEGIN$/gmu);
  const bodyEnd = exactlyOneStructuredField(segment, /^BODY_END$/gmu);
  if (!marker || !payloadHeader || !bodyBegin || !bodyEnd
    || (segment.match(/\[robb-resume[^\]\[\r\n]*\]/giu)?.length ?? 0) !== 1
    || bodyBegin.index === undefined || bodyEnd.index === undefined
    || payloadHeader.index === undefined
    || payloadHeader.index >= bodyBegin.index
    || bodyBegin.index >= bodyEnd.index) return undefined;

  const bodyStart = bodyBegin.index + bodyBegin[0].length;
  if (segment[bodyStart] !== '\n' || segment[bodyEnd.index - 1] !== '\n') return undefined;
  const body = segment.slice(bodyStart + 1, bodyEnd.index - 1);
  if (!body || /\0/u.test(body)) return undefined;

  const withoutBody = `${segment.slice(0, bodyStart + 1)}[authorized body omitted]\n${segment.slice(bodyEnd.index)}`;
  const from = exactlyOneStructuredField(withoutBody, /^-[ \t]*From[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu);
  const to = exactlyOneStructuredField(withoutBody, /^-[ \t]*To[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu);
  const cc = exactlyOneStructuredField(withoutBody, /^-[ \t]*CC[ \t]*:[ \t]*\[\][ \t]*$/gimu);
  const bcc = exactlyOneStructuredField(withoutBody, /^-[ \t]*BCC[ \t]*:[ \t]*\[\][ \t]*$/gimu);
  const subject = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Subject|Sujet)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const bodyDeclaration = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Texte du message|Message body)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const attachments = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*(?:Attachments?|Pieces jointes|Pièces jointes)[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const signature = exactlyOneStructuredField(
    withoutBody,
    /^-[ \t]*Signature[ \t]*:[ \t]*([^ \t\r\n][^\r\n]*)$/gimu,
  );
  const attachmentPaths = attachments?.[1]
    ? structuredGmailSendAttachmentPaths(attachments[1])
    : undefined;
  if (!from?.[1] || !to?.[1] || !cc || !bcc || !subject?.[1]
    || !bodyDeclaration?.[1] || !attachments || !signature?.[1]
    || !attachmentPaths
    || !isCanonicalEmailAddress(from[1]) || !isCanonicalEmailAddress(to[1])) return undefined;

  const payloadPrelude = segment.slice(
    payloadHeader.index + payloadHeader[0].length,
    bodyBegin.index,
  );
  const allowedPayloadLine = /^-\s*(?:(?:From|To|CC|BCC|Subject|Sujet|Attachments?|Pieces jointes|Pièces jointes)\s*:|(?:Texte du message|Message body)\s*:|Signature\s*:)/iu;
  const payloadLines = payloadPrelude.split('\n').map(line => line.trim()).filter(Boolean);
  if (payloadLines.length !== 8 || payloadLines.some(line => !allowedPayloadLine.test(line))) {
    return undefined;
  }

  const normalizedOutsideBody = normalizeForMatch(withoutBody);
  if (!STRUCTURED_GMAIL_SEND_DIRECT_IMPERATIVE.test(normalizedOutsideBody)) return undefined;
  const hasRevocation = hasGlobalExternalActionRevocation(withoutBody)
    || requestClauses(withoutBody).some(clause => {
      const normalizedClause = normalizeForMatch(clause);
      return STRUCTURED_GMAIL_SEND_NO_SEND_DIRECTIVE.test(normalizedClause)
        && !STRUCTURED_GMAIL_SEND_SAFE_ABSENCE_GUARD.test(normalizedClause);
    });
  if (hasRevocation) return undefined;

  // The body is data, but every other line is authority-bearing control text.
  // Exactly the declared From and To addresses may occur once outside BODY;
  // an extra/repeated address or a retarget hidden on a payload annotation is
  // a conflicting boundary and must not be discarded with the declaration.
  const outsideBodyEmails = [...withoutBody.matchAll(
    /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/giu,
  )].map(match => match[0]);
  if (outsideBodyEmails.length !== 2
    || outsideBodyEmails.filter(email => email === from[1]).length !== 1
    || outsideBodyEmails.filter(email => email === to[1]).length !== 1
    || STRUCTURED_GMAIL_SEND_RETARGET.test(normalizedOutsideBody)) {
    return undefined;
  }

  return { from: from[1], to: to[1], subject: subject[1], body, attachmentPaths };
}

const STRUCTURED_GMAIL_SEND_ALLOWED_INPUT_KEYS = new Set([
  'to', 'cc', 'bcc', 'sendAsEmail', 'subject', 'body', 'isHtml', 'attachmentPaths',
  'requireKnownContacts', 'allowExternal', 'checkContacts', '_displayName', '_intent',
]);

function canonicalGmailSendInputMismatchCategories(
  input: Record<string, unknown>,
  payload: StructuredGmailSendResumePayload,
): StructuredGmailSendMismatchCategory[] {
  const mismatches: StructuredGmailSendMismatchCategory[] = [];
  if (Object.hasOwn(input, 'from')) mismatches.push('unexpected-from');
  if (Object.hasOwn(input, 'replyTo')) mismatches.push('unexpected-replyTo');
  if (Object.keys(input).some(key => !STRUCTURED_GMAIL_SEND_ALLOWED_INPUT_KEYS.has(key)
    && key !== 'from' && key !== 'replyTo')) mismatches.push('unknown-fields');
  if (input.to !== payload.to) mismatches.push('to');
  if (input.sendAsEmail !== payload.from) mismatches.push('sendAsEmail');
  if (input.subject !== payload.subject) mismatches.push('subject');
  if (input.body !== payload.body) mismatches.push('body');
  if (input.isHtml !== false) mismatches.push('isHtml');
  if (!Array.isArray(input.attachmentPaths)
    || input.attachmentPaths.length !== payload.attachmentPaths.length
    || input.attachmentPaths.some((path, index) => path !== payload.attachmentPaths[index])) {
    mismatches.push('attachmentPaths');
  }
  if (Object.hasOwn(input, 'cc') && input.cc !== '') mismatches.push('cc');
  if (Object.hasOwn(input, 'bcc') && input.bcc !== '') mismatches.push('bcc');
  if (['requireKnownContacts', 'allowExternal', 'checkContacts'].some(key => (
    Object.hasOwn(input, key) && typeof input[key] !== 'boolean'
  ))) mismatches.push('optional-guard-types');
  if (['_displayName', '_intent'].some(key => (
    Object.hasOwn(input, key)
      && (typeof input[key] !== 'string' || /\0/u.test(input[key] as string))
  ))) mismatches.push('metadata-types');
  return mismatches;
}

/** Bind a mutating Gmail call to the newest applicable authenticated restart
 * segment. A later revocation, retarget, or send-specific amendment owns the
 * boundary and cannot fall through to an older structured authorization. */
export function structuredGmailSendAuthorizationDiagnostic(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): StructuredGmailSendAuthorizationDiagnostic {
  if (toolName !== GMAIL_SEND_TOOL) {
    return { decision: 'not-applicable', mismatchCategories: [] };
  }
  const hasStructuredMarker = objectiveSegments.some(segment => (
    /\[robb-resume(?::|\])/iu.test(segment)
  ));
  if (!hasStructuredMarker) {
    return { decision: 'not-applicable', mismatchCategories: [] };
  }
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    const normalized = normalizeForMatch(segment);
    if (!normalized) continue;
    if (/\[robb-resume(?::|\])/iu.test(segment)) {
      const payload = parseStructuredGmailSendResumeSegment(segment);
      if (!payload) {
        return {
          decision: 'invalid',
          mismatchCategories: ['authenticated-contract-unavailable'],
        };
      }
      const mismatchCategories = canonicalGmailSendInputMismatchCategories(input, payload);
      return {
        decision: mismatchCategories.length === 0 ? 'authorized' : 'invalid',
        mismatchCategories,
      };
    }
    if (hasGlobalExternalActionRevocation(segment)) {
      return { decision: 'invalid', mismatchCategories: ['authorization-boundary'] };
    }
    if (isTargetFreeGenericContinuation(normalized)) continue;
    // A structured restart is a closed exact-effect capability. Any newer
    // substantive authenticated segment owns the boundary, including terse
    // changes to the body/subject/attachment or an indirect stop instruction.
    // Only a target-free generic continuation may preserve the older payload.
    return { decision: 'invalid', mismatchCategories: ['authorization-boundary'] };
  }
  return {
    decision: 'invalid',
    mismatchCategories: ['authenticated-contract-unavailable'],
  };
}

export function structuredGmailSendAuthorizationDecision(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): StructuredGmailSendAuthorizationDecision {
  return structuredGmailSendAuthorizationDiagnostic(
    toolName,
    input,
    objectiveSegments,
  ).decision;
}

export function isStructuredGmailSendAuthorizedByObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  return structuredGmailSendAuthorizationDecision(
    toolName,
    input,
    objectiveSegments,
  ) === 'authorized';
}

export function isTargetFreeGenericContinuation(request: string): boolean {
  const withoutPoliteness = normalizeForMatch(request)
    .replace(/^(?:please|s il te plait|s il vous plait|stp|svp)\s+/, '')
    .replace(/\s+(?:please|s il te plait|s il vous plait|stp|svp)$/, '');
  return GENERIC_CONTINUATIONS.has(withoutPoliteness)
    || /^(?:continue|continuez|poursuis|poursuit|poursuivez|reprend|reprends|reprenez|resume|proceed|go ahead)(?:\s+sans\s+(?:(?:t\s+|vous\s+)?arreter)|\s+et\s+va\s+(?:reellement\s+)?jusqu\s+au\s+bout\s+de\s+(?:la|cette)\s+mission|\s+(?:(?:l|la)\s+)?analyse(?:\s+et\s+(?:(?:l|la)\s+)?optimisation)?)?$/u.test(withoutPoliteness);
}

/** A closed progress question or acknowledgement does not retarget a signed
 * exact-effect contract. Keep this narrower than generic conversation: any
 * named project, source, path, target or additional instruction remains a
 * meaningful authority boundary and therefore cannot revive an older grant. */
function isClosedTargetFreeProgressFollowUp(
  rawRequest: string,
  normalizedRequest = normalizeForMatch(rawRequest),
): boolean {
  if (rawRequest.length > 240 || /```|~~~|^\s*>/mu.test(rawRequest)) return false;
  return /^(?:ou en (?:es tu|sommes nous)|quel(?:le)?s? (?:est|sont) (?:le |la |les )?(?:statut|avancement)|(?:peux tu |pouvez vous |pourrais tu |pourriez vous )?(?:me |nous )?(?:donner|donne|donnez|faire|fais|faites) (?:moi |nous )?(?:un|le) (?:point d avancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/u.test(normalizedRequest);
}

const LEGACY_CONTEXTUAL_GMAIL_REPLY_TOOL = 'mcp__google-contacts__gmail_reply';
const CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL = 'mcp__google-contacts__gmail_reply_preflight';
const CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_TOOL = 'mcp__google-contacts__gmail_reply_all_preflight';
const CONTEXTUAL_GMAIL_REPLY_TOOL = 'mcp__google-contacts__gmail_reply_bound';
const CONTEXTUAL_GMAIL_REPLY_ALL_TOOL = 'mcp__google-contacts__gmail_reply_all';
const CONTEXTUAL_GMAIL_SEND_TOOL = 'mcp__google-contacts__gmail_send';
const GMAIL_MESSAGE_ID = /^[0-9a-f]{12,32}$/iu;
const CONTEXTUAL_GMAIL_REPLY_KEYS = new Set([
  'messageId', 'expectedRecipientEmail', 'expectedSenderEmail', 'recipientBinding', 'body', 'isHtml',
  '_displayName', '_intent',
]);
const CONTEXTUAL_GMAIL_REPLY_ALL_KEYS = new Set([
  'messageId', 'expectedSenderEmail', 'recipientBinding', 'body', 'isHtml', '_displayName', '_intent',
]);
const CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_KEYS = new Set([
  'messageId', 'expectedRecipientEmail', 'expectedSenderEmail', 'body', 'isHtml', '_displayName', '_intent',
]);
const CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_KEYS = new Set([
  'messageId', 'expectedSenderEmail', 'body', 'isHtml', '_displayName', '_intent',
]);
const CONTEXTUAL_REPLY_VERB = /\b(?:reply|respond|answer|write\s+back|repond|reponds|repondez|repondre)\b|\bfais(?:\s+(?:lui|leur))?\s+un\s+retour\b|\beffectue(?:r|s|z)?\s+(?:(?:une?|la)\s+)?(?:unique\s+)?(?:reponse|envoi)\s+(?:(?:via|par)\s+)?(?:l\s+)?(?:api|gmail)\b/u;
const CONTEXTUAL_REPLY_PREPARATION = /\b(?:prepare|prepares|preparer|redige|rediger|draft|compose|composes|composer|write)\b[^.!?;\n]{0,60}\b(?:reply|response|reponse)\b/u;
const CONTEXTUAL_SEND_VERB = /\b(?:send|envoi|envoie|envoyer|transmets|transmettre)\b/u;
const CONTEXTUAL_REPLY_PRONOUN = /\b(?:reply|respond|answer|write\s+back)\s+(?:back\s+)?(?:to\s+)?(?:all|everyone|them|him|her|this\s+(?:email|message)|that\s+(?:email|message)|the\s+(?:email|message|sender))\b|\b(?:repond|reponds|repondez|repondre)\s+(?:a\s+)?(?:tous|toutes|leur|lui|ce\s+(?:mail|courriel|message)|cet\s+email|l\s+(?:email|courriel)|au\s+(?:mail|courriel|message))\b|\bfais\s+(?:lui|leur)\s+un\s+retour\b/u;
const CONTEXTUAL_REPLY_THREAD = /\b(?:(?:dans|sur)\s+(?:(?:ce|le)\s+)?(?:meme\s+)?fil(?:\s+(?:existant|actuel|original|d\s+origine))?|(?:in|on)\s+(?:(?:this|the)\s+)?(?:(?:same|existing|current|original)\s+)?thread|same\s+recipients?|existing\s+recipients?|sans\s+(?:modifier|changer|alterer)\s+(?:les\s+)?destinataires|without\s+(?:changing|modifying|altering)\s+(?:the\s+)?recipients?)\b/u;
const CONTEXTUAL_REPLY_ALL_SCOPE = /\b(?:reply\s+all|reply\s+to\s+(?:all\b(?!\s+(?:(?:the|its|their)\s+)?(?:questions?|points?|arguments?|items?|topics?|comments?|concerns?|requests?|remarks?|objections?|demands?))|everyone|them|each\s+recipient|every\s+recipient|the\s+whole\s+list)|respond\s+to\s+(?:all\b(?!\s+(?:(?:the|its|their)\s+)?(?:questions?|points?|arguments?|items?|topics?|comments?|concerns?|requests?|remarks?|objections?|demands?))|everyone|them|each\s+recipient|every\s+recipient|the\s+whole\s+list)|answer\s+everyone|repond(?:s|ez|re)?\s+(?:a\s+)?(?:tous\b(?!\s+(?:(?:les|ses|leurs?)\s+)?(?:points?|questions?|arguments?|sujets?|elements?|commentaires?|demandes?|requetes?|soucis?|remarques?|objections?))|toutes\b(?!\s+(?:(?:les|ses|leurs?)\s+)?(?:questions?|remarques?|objections?|demandes?|requetes?|preoccupations?))|leur|chacun|tout\s+le\s+monde|l\s+ensemble\s+des\s+destinataires|toute\s+la\s+liste)|sans\s+(?:modifier|changer|alterer)\s+(?:les\s+)?destinataires|without\s+(?:changing|modifying|altering)\s+(?:the\s+)?recipients?|ne\s+(?:modifie|change)\s+pas\s+(?:les\s+)?destinataires|ne\s+retire\s+aucun\s+destinataire)\b/u;
const CONTEXTUAL_REPLY_NEGATION = /\b(?:do\s+not|don\s+t|never|must\s+not)\s+(?:reply|respond|send)\b|\bi\s+don\s+t\s+want\s+you\s+to\s+(?:reply|respond|send)\b|\byou\s+shouldn\s+t\s+(?:reply|respond|send)\b|\bno\s+(?:reply|response)\s+should\s+be\s+sent\b|\b(?:merci\s+de\s+)?ne\s+pas\s+(?:repondre|envoyer)\b|\b(?:ne|n)\s+(?:repond|reponds|repondez|repondre|envoie|envoyer)\b[^.!?;\n]{0,80}\b(?:pas|jamais|plus)\b|\bn\s+envoie\b[^.!?;\n]{0,30}\baucune?\s+(?:reponse|message|mail|email)\b|\bne\s+(?:surtout\s+)?jamais\s+(?:repondre|envoyer)\b|\bil\s+ne\s+faut\b[^.!?;\n]{0,50}\b(?:pas|jamais)\b[^.!?;\n]{0,40}\b(?:repondre|envoyer)\b|\b(?:repondre|envoyer)\b[^.!?;\n]{0,50}\b(?:est|reste)\s+interdit\b|\bje\s+ne\s+te\s+demande\s+pas\s+de\s+(?:repondre|envoyer)\b|\b(?:je\s+t\s+interdis|hors\s+de\s+question)\b[^.!?;\n]{0,50}\b(?:repondre|envoyer)\b|\b(?:evite|evitez|abstiens\s+toi|abstenez\s+vous)\s+(?:d\s+y|de)\s+(?:repondre|envoyer)\b|\b(?:tu|vous)\s+n\s+(?:es|etes)\s+pas\s+autorise(?:e|es|s)?\s+a\s+(?:repondre|envoyer)\b|\btu\s+ne\s+dois\s+en\s+aucun\s+cas\s+(?:repondre|envoyer)\b|\b(?:you\s+are\s+not\s+allowed|i\s+refuse\s+to\s+let\s+you)\s+(?:to\s+)?(?:reply|respond|send)\b|\b(?:sans\s+repondre|without\s+(?:replying|responding))\b/u;
const CONTEXTUAL_REPLY_EXPLICIT_RETARGET = /\b(?:reply|respond|repond|reponds|repondez|repondre)\b[^.!?;\n]{0,100}\b(?:instead|plutot|rather)\b|\b(?:change|replace|remplace|modifie)\b[^.!?;\n]{0,80}\b(?:recipient|recipients|destinataire|destinataires)\b|\b(?:finalement|actually)\b[^.!?;\n]{0,40}\b(?:transfere|transferer|forward)\b[^.!?;\n]{0,40}(?:\binstead\b)?/u;
const CONTEXTUAL_REPLY_THREAD_REJECTION = /\b(?:pas|not)\b[^.!?;\n]{0,35}\b(?:(?:dans|sur)\s+(?:ce|le)?\s*(?:meme\s+)?fil|(?:in|on)\s+(?:this|the)?\s*(?:same\s+)?thread)\b|\b(?:dans|sur|in|on)\s+(?:un|une|a|another|other)?\s*(?:nouveau|nouvelle|new|autre|another|other)\s+(?:fil|thread|mail|email|message)\b|\b(?:ne|n)\s+(?:repond|reponds|repondez|repondre|envoie|envoyer)\b[^.!?;\n]{0,50}\brien\b|\b(?:reply|respond|send)\s+nothing\b/u;
const CONTEXTUAL_GMAIL_INLINE_REPLY_TO_FIELD = /`replyTo`/giu;
const CONTEXTUAL_REPLY_CONFIRMATION_BOUNDARY = /\b(?:only\s+)?(?:after|apres)\s+(?:(?:my|ma|mon|notre|the|la|le)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:apres\s+obtention\s+de|upon\s+obtaining)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization)\b|\b(?:pas\s+avant|not\s+before)\s+(?:(?:my|ma|mon|notre|the|la|le)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:pas\s+sans|not\s+without|pending)\s+(?:(?:my|ma|mon|notre|our)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu\s+vert)\b|\b(?:sous\s+(?:reserve|condition)\s+(?:de|que)|subject\s+to|conditional\s+on)\b[^.!?;\n]{0,70}\b(?:confirmation|approval|approving|autorisation|validation|accord|feu\s+vert|valid)\w*\b|\b(?:des|avec)\s+(?:(?:mon|ma|notre)\s+)?(?:accord|feu\s+vert)\s+(?:uniquement|seulement)?\b|\b(?:confirmation|approval|autorisation|validation|accord|feu vert)\s+(?:required|requis|requise|necessaire)\b|\b(?:demande(?:-moi)?|ask\s+me)\b[^.!?;\n]{0,50}\b(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:(?:une\s+fois\s+que|apres\s+que|lorsque|quand|once|when)|(?:(?:uniquement|seulement)\s+)?si|only\s+if|unless|a\s+condition\s+que|pourvu\s+que|provided\s+that|as\s+soon\s+as)\s+(?:je|nous|i|we|tu|vous|you)\b[^.!?;\n]{0,90}\b(?:valid(?:e|er)?|confirm(?:e|er)?|approv(?:e|al)|autoris(?:e|ation)|accord|oppose|recois|receiv|get|have|dis\s+oui|say\s+yes|feu\s+vert|go\s+ahead)\b|\b(?:uniquement|seulement|only)\s+(?:avec|with)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:autorisation|authorization|approval|accord|feu\s+vert)(?:\s+explicite|\s+explicit)?\b|\b(?:avec|with)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:autorisation|authorization|approval|accord|feu\s+vert)\s+(?:uniquement|seulement|only)\b|\b(?:apres|upon)\s+(?:la\s+|reception\s+de\s+|receiving\s+)?(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization|feu\s+vert)\b|\b(?:une\s+fois|once)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization)\s+(?:recu|received)\b|\ben\s+attendant\s+(?:(?:mon|ma|notre|le)\s+)?(?:accord|validation|confirmation|autorisation|feu\s+vert)\b/u;
const CONTEXTUAL_REPLY_AUDIENCE_CHANGE = /\b(?:sauf|hormis|except|excepte|excluding|other\s+than)\b|\ba\s+(?:l\s+exception\s+de|part)\b|\b(?:omit|en\s+retirant|sans\s+inclure|leaving)\b[^.!?;\n]{0,80}(?:\bout\b|[a-z0-9@._+-]+)|\b(?:uniquement|seulement|only)\s+(?:a|to)\s+[a-z0-9@._+-]+\b|\b(?:exclude|exclure|exclus|exclue|retire|retirer|remove|ajoute|ajouter|add|include|inclure)\s+[a-z0-9@._+-]+\b|\b(?:exclude|exclure|exclus|retire|retirer|remove|ajoute|ajouter|add|include|inclure)\b[^.!?;\n]{0,100}\b(?:cc|copie|recipient|recipients|destinataire|destinataires|audience)\b|\b(?:mets?|mettre|copie|copier|copiant|sans\s+(?:mettre|copier)|avec)\b[^.!?;\n]{0,100}\b(?:cc|en\s+copie)\b|\b(?:conserv(?:e|er|ant)|garde|garder|keep)\b[^.!?;\n]{0,70}\b(?:uniquement|seulement|only)\b|\b(?:mais|but)\s+(?:pas|sans|without|enleve|oublie|drop|leave|retire|exclue?)\b[^.!?;\n]{0,40}\b[a-z0-9@._+-]+\b|\b(?:leave\s+[a-z0-9@._+-]+\s+off|drop\s+[a-z0-9@._+-]+|minus\s+[a-z0-9@._+-]+|just\s+not\s+[a-z0-9@._+-]+|enleve\s+[a-z0-9@._+-]+|moins\s+(?!tard\b)[a-z0-9@._+-]+|oublie\s+[a-z0-9@._+-]+|en\s+omettant\s+[a-z0-9@._+-]+)\b|\b(?:including|along\s+with|y\s+compris|en\s+incluant|ajoute|plus(?!\s+tard\b)|and\s+copy|et\s+copie)\s+[a-z0-9@._+-]+\b|\bavec\s+[a-z0-9@._+-]+\s+aussi\b|\b(?:separement|separately|individually|hors\s+de\s+ce\s+fil|outside\s+(?:this|the)\s+thread|par\s+(?:un|une)\s+(?:nouveau|nouvelle)\s+(?:mail|email|message))\b/u;
const CONTEXTUAL_REPLY_NAMED_AUDIENCE_CHANGE = /\b(?:keep\s+[a-z0-9@._+-]+\s+out|without\s+[a-z0-9@._+-]+\s+copied|with\s+[a-z0-9@._+-]+\s+copied|put\s+[a-z0-9@._+-]+\s+on\s+(?:cc|bcc)|(?:cc|bcc)\s+[a-z0-9@._+-]+|sans\s+[a-z0-9@._+-]+\s+en\s+copie|mets?\s+[a-z0-9@._+-]+\s+parmi\s+les\s+destinataires|[a-z0-9@._+-]+\s+(?:en\s+copie|cc|bcc))\b/u;
const CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE = /\b(?:ne\s+(?:modifie|change|altere)\s+pas\s+(?:les\s+)?destinataires|ne\s+(?:retire|supprime|exclus)\s+aucun\s+destinataire|sans\s+inclure\s+de\s+nouveau\s+destinataire|do\s+not\s+(?:change|modify|alter|remove|exclude)\s+(?:the\s+|any\s+)?recipients?|leaving\s+(?:the\s+)?recipients?\s+unchanged|without\s+(?:including|adding)\s+any\s+new\s+recipient|omitting\s+no\s+recipients?)\b/gu;
const CONTEXTUAL_REPLY_NON_AUDIENCE_CONSTRAINT = /\b(?:(?:leaving|keeping|keep|leave|garde|garder|laisse|laisser)\s+(?:the\s+|le\s+|la\s+|l\s+)?(?:subject|wording|body|content|objet|formulation|contenu|texte)\s+(?:unchanged|identical|inchange|inchangee|identique)|(?:excluding|without\s+including|sans\s+inclure|en\s+excluant)\s+(?:any\s+|the\s+|de\s+|des\s+)?(?:attachments?|pieces?\s+jointes?|files?|fichiers?)|(?:avec|with)\s+(?:exactement\s+)?(?:les\s+)?(?:memes?|same)\s+(?:fil|thread)\b[^.!?;\n]{0,180}\b(?:corps|body)\b[^.!?;\n]{0,100})\b/gu;
const CONTEXTUAL_REPLY_DUPLICATE_CHECK = /\b(?:exclude|exclure)\s+(?:tout\s+|any\s+)?(?:envoi|email|e\s+mail|mail|message|send)\s+(?:deja\s+|already\s+)?(?:effectue|envoye|produit|sent|made)\b/gu;
const CONTEXTUAL_REPLY_SIGNED_PREFLIGHT_FIELDS = /\bavec\s+exactement\s+(?:le\s+)?jeton\s+(?:le\s+)?destinataire\s+(?:les\s+)?cc\s+(?:le\s+)?fil\s+et\s+(?:le\s+)?corps\s+lies?\s+par\s+ce\s+preflight\b/gu;
const CONTEXTUAL_REPLY_IDEMPOTENT_SEND_CONDITION = /\b(?:s\s+il\s+n\s+est\s+pas\s+deja\s+envoye|(?:(?:seulement|uniquement)\s+)?s\s+il\s+est\s+absent|only\s+if\s+(?:(?:it|the\s+(?:exact\s+)?effect|the\s+(?:reply|message|send))\s+is\s+)?absent|if\s+(?:it|the\s+(?:exact\s+)?effect|the\s+(?:reply|message|send))\s+is\s+not\s+already\s+(?:present|sent))\b/gu;
const CONTEXTUAL_REPLY_POSITIVE_EXISTENCE_NO_RESEND = /\b(?:(?:aucun|pas\s+de)\s+(?:second|nouvel|autre)\s+(?:envoi|message|email|mail)|ne\s+(?:renvoie|reponds|envoie)\s+pas|do\s+not\s+(?:resend|reply|send)|no\s+(?:second|new|other)\s+(?:send|reply|message|email)|reuse\s+(?:the\s+)?existing\s+(?:effect|message))\b[^.!?;\n]{0,120}\b(?:si|if)\s+(?:(?:l\s+)?effet\s+exact|the\s+exact\s+effect)\s+(?:apparait|existe|est\s+present|appears|exists|is\s+present)\b/u;
const CONTEXTUAL_REPLY_EXACT_EFFECT_CONTINUATION = /\b(?:verifie(?:z)?\s+(?:d\s+abord\s+)?(?:l\s+)?absence|check\s+(?:first\s+)?(?:that\s+)?(?:the\s+)?(?:exact\s+)?effect\s+is\s+absent)\b[^.!?;\n]{0,180}\b(?:seulement\s+s\s+il\s+est\s+absent|only\s+if\s+(?:(?:it|the\s+(?:exact\s+)?effect)\s+is\s+)?absent)\b[^.!?;\n]{0,120}\b(?:effectue(?:r|s|z)?\s+(?:(?:une?|la)\s+)?(?:unique\s+)?(?:reponse|envoi)\s+(?:(?:via|par)\s+)?(?:l\s+)?(?:api|gmail)|perform\s+(?:(?:one|a|single)\s+)?(?:api|gmail)\s+(?:reply|response|send))\b/u;
// This is deliberately a closed continuation grammar, not standalone send
// authority. It refers back to an exact effect already authorized in the
// authenticated history and requires the current segment to carry one anchor.
const CONTEXTUAL_REPLY_CONCLUSIVE_ABSENCE_CONTINUATION = /\bseulement\s+si\s+l\s+absence\s+exacte\s+est\s+concluante\b[^.!?;\n]{0,200}\bexecute\s+(?:au\s+plus\s+)?une\s+unique\s+reponse\s+liee\s+a\s+(?:l|cette)\s+ancre\b/u;
const CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD = /\b(?:payload\s+(?:obligatoire\s+et\s+immuable|required\s+and\s+immutable)|required\s+and\s+immutable\s+payload)\b/iu;
// Structured restart prompts use literal tool names and a closed immutable
// payload instead of the shorter natural-language continuation above. Keep
// this grammar narrow: it must require the canonical preflight, both Gmail
// reconciliation scopes, the zero-candidate result, and the bound reply tool.
const CONTEXTUAL_REPLY_STRUCTURED_EXACT_EFFECT_CONTINUATION = /\b(?:avant\s+toute\s+mutation|before\s+any\s+mutation)\b.{0,1200}\bgmail\s+reply\s+preflight\b.{0,1800}\bsent\b.{0,500}\bdraft\b.{0,900}\bcandidate\s+count\s+0\b.{0,1200}\b(?:seulement\s+si\s+toutes\s+ces\s+conditions\s+sont\s+satisfaites|only\s+if\s+all\s+(?:of\s+)?these\s+conditions\s+are\s+satisfied)\b.{0,800}\bgmail\s+reply\s+bound\b/u;
// The negative half of that same exact-once branch is a safety condition, not
// a revocation: no send is permitted when a duplicate may exist or pagination
// makes the read ambiguous. Keep this narrow so an unconditional "n'envoie
// rien" continues to revoke authority.
const CONTEXTUAL_REPLY_DUPLICATE_AMBIGUITY_NO_SEND = /^(?:si\s+un\s+envoi(?:\s+ou\s+un\s+brouillon)?\s+identique\s+existe\s+peut\s+exister\s+ou\s+si\s+la\s+pagination\s+la\s+lecture\s+reste\s+ambigue\s+n\s+envoie\s+rien(?:\s+et\s+cloture\s+sur\s+cette\s+preuve)?|si\s+un\s+candidat\s+une\s+ambiguite\s+ou\s+une\s+preuve\s+incomplete\s+apparait\s+n\s+envoie\s+rien\s+et\s+cloture\s+factuellement|if\s+a\s+candidate\s+an\s+ambiguity\s+or\s+incomplete\s+evidence\s+appears\s+do\s+not\s+send\s+anything\s+and\s+close\s+factually)$/u;
const CONTEXTUAL_REPLY_STRUCTURED_BOUND_EXECUTION = /^(?:seulement\s+si\s+toutes\s+ces\s+conditions\s+sont\s+satisfaites\s+utilise\s+immediatement\s+le\s+recipient\s+binding\s+frais\s+dans\s+au\s+plus\s+un(?:e)?\s+unique\s+gmail\s+reply\s+bound\s+au\s+payload\s+strictement\s+identique|only\s+if\s+all(?:\s+of)?\s+these\s+conditions\s+are\s+satisfied\s+immediately\s+use\s+the\s+fresh\s+recipient\s+binding\s+in\s+at\s+most\s+one\s+gmail\s+reply\s+bound(?:\s+call)?\s+with\s+the\s+strictly\s+identical\s+payload)$/u;
const CONTEXTUAL_REPLY_STRUCTURED_RECONCILIATION = /^(?:continue\s+uniquement\s+si\b(?=[\s\S]{0,900}\breconciliation\s+sent\s+et\s+draft\b)(?=[\s\S]{0,900}\b(?:entierement\s+)?paginee\b)(?=[\s\S]{0,900}\bcandidate\s+count\s+0\b)|continue\s+only\s+if\b(?=[\s\S]{0,900}\bsent\s+and\s+draft\s+reconciliation\b)(?=[\s\S]{0,900}\bfully\s+paginated\b)(?=[\s\S]{0,900}\bcandidate\s+count\s+0\b))[\s\S]{1,900}$/u;
const CONTEXTUAL_REPLY_STRUCTURED_UNCERTAIN_RESULT = /^(?:ne\s+repete\s+jamais\s+l\s+effet\s+si\s+le\s+resultat\s+de\s+l\s+appel\s+est\s+incertain\s+reconcilie\s+sent\s+et\s+draft\s+avant\s+toute\s+decision|never\s+repeat\s+the\s+effect\s+if\s+the\s+call\s+result\s+is\s+uncertain\s+reconcile\s+sent\s+and\s+draft\s+before\s+any\s+decision)$/u;
const CONTEXTUAL_REPLY_SENT_DRAFTS_RECONCILIATION = /^(?:reconcilie\s+d\s+abord\s+par\s+api\s+l\s+ancre\s+[0-9a-f]{12,32}\s+ainsi\s+que\s+sent\s+et\s+drafts\s+avec\s+comparaison\s+exacte\s+complete\s+de\s+l\s+effet\s+autorise\s+dans\s+ce\s+chat|reconcilie\s+d\s+abord\s+par\s+api\s+l\s+ancre\s+[0-9a-f]{12,32}\s+et\s+le\s+fil\s+complet\s+dans\s+sent\s+et\s+drafts\s+avec\s+pagination\s+complete\s+et\s+comparaison\s+exacte\s+de\s+l\s+effet\s+autorise\s+dans\s+ce\s+chat)$/u;
const CONTEXTUAL_REPLY_NAMED_AUDIENCE_REMOVAL = /\b(?:(?:do\s+not|don\s+t)\s+copy\s+[a-z0-9@._+-]+|take\s+[a-z0-9@._+-]+\s+off\s+(?:the\s+)?(?:thread|recipients?|cc)|ne\s+copie\s+pas\s+[a-z0-9@._+-]+|(?:passe|deplace)\s+[a-z0-9@._+-]+\s+en\s+(?:cci|bcc))\b/u;
const CONTEXTUAL_REPLY_NO_SEND_BOUNDARY = /\b(?:brouillons?|drafts?|(?:garde|garder|laisse|laisser)\b[^.!?;\n]{0,30}\bdans\s+(?:les\s+)?brouillons?|sans\s+(?:(?:l|la|le)(?:['’]\s*|\s+))?(?:envoyer|envoi|transmettre|expedier|soumettre|passer\s+a\s+l\s+envoi)|without\s+(?:sending|send|transmitting|submitting|dispatch)|(?:ne|sans)\s+(?:clique(?:r)?|appuie|click(?:ing)?|press|hit)\b[^.!?;\n]{0,45}\b(?:envoyer|send|bouton\s+d\s+envoi|send\s+button)|(?:merci\s+de\s+)?ne\s+pas\s+(?:envoyer|transmettre|expedier|soumettre|livrer|deliver|valider\s+l\s+envoi|declencher\s+l\s+envoi|finaliser\s+l\s+envoi)|(?:make\s+sure\s+not\s+to|refrain\s+from|avoid)\s+(?:send(?:ing)?|deliver(?:ing)?|submit(?:ting)?|transmit(?:ting)?)|do\s+not\s+(?:actually\s+send|send|deliver|submit|transmit|click\s+(?:the\s+)?send(?:\s+button)?|finalize\s+the\s+send|trigger\s+delivery)(?:\s+it)?(?:\s+yet)?|don\s+t\s+(?:send|deliver|submit|transmit|hit\s+(?:the\s+)?send(?:\s+button)?|go\s+through\s+with\s+sending)(?:\s+it)?|ne\s+(?:(?:l|la|le)(?:['’]\s*|\s+))?(?:envoie|envoies|envoyez|envoyer|transmets|transmettez|transmettre|expedie|expedies|expediez|expedier|soumets|soumettre|declenche|finalise)\s+pas(?:\s+encore)?|ne\s+clique\s+pas\b[^.!?;\n]{0,35}\bbouton\s+d\s+envoi\b|ne\s+(?:le|la)\s+fais\s+pas\s+partir|je\s+ne\s+veux\s+aucun\s+envoi|(?:je\s+veux\s+relire|let\s+me\s+review(?:\s+it)?)\b[^.!?;\n]{0,40}\b(?:avant\s+l\s+envoi|before\s+sending)|(?:pour\s+(?:ma\s+)?(?:relecture|validation)\s+(?:uniquement|seulement)|for\s+my\s+review\s+only|not\s+for\s+sending)|(?:retiens?|bloque|hold|mets?)\b[^.!?;\n]{0,30}\b(?:l\s+envoi|attente\s+d\s+envoi|email|mail)|save\s+it\s+without\s+dispatch|(?:ne\s+)?procede\s+pas\s+a\s+(?:l\s+)?envoi|sans\s+proceder\s+a\s+(?:l\s+)?envoi|ne\s+fais\s+pas\s+partir\s+(?:le|la|l)\s+(?:mail|email|courriel|message)|(?:laisse\s+moi\s+(?:l\s+envoyer|faire\s+partir\s+(?:le|la|l)\s+(?:mail|email|courriel|message))|je\s+ferai\s+l\s+envoi\s+moi\s+meme|leave\s+the\s+final\s+send\s+to\s+me|i\s+will\s+send\s+it\s+myself|stop\s+short\s+of\s+sending)|(?:garde|keep|leave)\b[^.!?;\n]{0,30}\b(?:non\s+envoyee|unsent))\b/u;
const CONTEXTUAL_REPLY_REPORTED_SPEECH = /\b(?:report|rapport|document|message|email|mail|note)\b[^.!?;\n]{0,100}\b(?:recommends?|recommendation|recommande|suggests?|suggere|says?|states?|dit|indique|asks?|demande)\b[^.!?;\n]{0,45}\b(?:to\s+)?(?:reply|respond|answer|send|de\s+(?:repondre|envoyer))\b|\b(?:m\s+a|nous\s+a|a)\s+demande\s+de\s+repondre\b/u;
const CONTEXTUAL_REPLY_META_INSTRUCTION = /\b(?:(?:voici|here\s+is|this\s+is|ci\s+dessous|below)\b[^.!?;\n]{0,80}\b(?:exemple|example|sample|modele|template|prompt|citation|quote)\b|(?:exemple|example|sample|modele|template|copie|copy)\s+(?:(?:de|d\s+un|du|of|for)\s+)?(?:prompt|instruction|request|demande|texte|text)\b|(?:citation|quote)\b|(?:texte\s+cite|quoted\s+text)\b|(?:prompt|instruction|texte|text)\s+(?:(?:contient|contains?|cite|quotes?)|(?:a\s+tester|to\s+test|a\s+analyser|to\s+analy[sz]e|non\s+executee?|not\s+executed))\b|(?:documentation|document|reference)\b[^.!?;\n]{0,80}\b(?:contient|contains?|cite|quotes?)\b[^.!?;\n]{0,50}\b(?:instruction|prompt|request|demande)\b|(?:supposons|suppose|imagine)\b[^.!?;\n]{0,60}\b(?:instruction|prompt|request|demande)\b|(?:je\s+veux\s+que\s+tu|i\s+want\s+you\s+to)\s+(?:analyses?|audites?|review|analy[sz]e)\b[^.!?;\n]{0,60}\b(?:prompt|instruction|texte|text)\b|(?:a\s+titre\s+d\s+exemple|pour\s+reference(?:\s+uniquement)?|for\s+reference(?:\s+only)?|hypothetical(?:ly)?|hypothetique(?:ment)?|sans\s+l\s+executer|do\s+not\s+execute|instruction\s+non\s+executee?|not\s+an\s+instruction))\b/u;
const CONTEXTUAL_REPLY_UNSATISFIED_CONDITION = /\b(?:once|when|if|provided(?:\s+that)?|as\s+soon\s+as|unless|une\s+fois\s+que|lorsque|quand|si|des\s+que|a\s+condition\s+que|pourvu\s+que)\b[^.!?;\n]{1,100}/u;
const CONTEXTUAL_REPLY_NON_DIRECTIVE = /\b(?:je\s+pense\s+qu\s+il\s+faudrait|il\s+faudrait|on\s+devrait|on\s+pourrait|tu\s+pourrais|tu\s+peux\s+peut\s+etre|peut\s+etre)\b[^.!?;\n]{0,60}\brepondre\b/u;
const CONTEXTUAL_REPLY_REPLACED_BY_READ_ONLY = /\b(?:(?:finalement|en\s+fait|actually)\b[^.!?;\n]{0,70}(?:(?:seulement|juste?|only)\b[^.!?;\n]{0,35}\b(?:analyse|analyze|resume|resumer|summary|summarize)|(?:analyse|analyze|resume|resumer|summary|summarize)\b[^.!?;\n]{0,35}\b(?:seulement|juste?|only))|(?:seulement|juste?|only)\s+(?:a\s+|un\s+)?(?:resume|summary|analyse|analysis)\b(?:[^.!?;\n]{0,30}\b(?:pas\s+(?:une\s+)?reponse|instead))?|ignore\s+(?:la\s+)?reponse\b[^.!?;\n]{0,40}\b(?:resume|summarize)|(?:analyse|analyze|resume|summary|summarize)\b[^.!?;\n]{0,35}\binstead\b)\b/u;
const CONTEXTUAL_UNRELATED_ADDITIONAL_SEND = /\b(?:rapport|report|pdf|document|fichier|file|notification\s+slack|slack\s+(?:message|notification))\b/u;
const CONTEXTUAL_REPLY_DEFERRED_BOUNDARY = /^(?:attends?|patiente|pause|pas\s+encore|stoppe|hold\s+on|wait|pause\s+there|not\s+yet|do\s+not\s+proceed|don\s+t\s+do\s+it\s+yet|i\s+ll\s+tell\s+you\s+when|je\s+te\s+dirai\s+quand|laisse\s+en\s+attente)\.?$|\b(?:pas\s+maintenant|not\s+now|plus\s+tard|later|demain|tomorrow|ce\s+soir|this\s+evening|(?:mais|but)\s+(?:attend(?:s|ez)?|pause)|attend(?:s|ez|re)?\s+pour\s+le\s+moment|wait\s+for\s+now|hold\s+off|attend(?:s|ez|re)?\s+(?:mon|ma|notre|le)\s+(?:accord|validation|confirmation|feu\s+vert)|wait\s+for\s+(?:my|our|the)\s+(?:approval|validation|confirmation|go-ahead)|quand\s+je\s+(?:confirme|valide|te\s+le\s+demanderai|te\s+le\s+dirai)|des\s+que\s+je\s+te\s+le\s+dirai|lorsque\s+je\s+te\s+dirai\s+de\s+le\s+faire|when\s+i\s+(?:confirm|approve|tell\s+you\s+to)|once\s+i\s+tell\s+you\s+to\s+do\s+it|(?:a|on)\s+(?:mon|my)\s+signal|(?:a|at)\s+(?:midi|noon)|(?:apres|after)\s+(?:le\s+)?(?:dejeuner|lunch))\b|\b(?:pas\s+avant|not\s+before|no\s+earlier\s+than|at|a)\s+\d{1,2}(?:(?::|h)\d{0,2})?\s*(?:am|pm|h)?\b|\b(?:dans|in)\s+(?:\d+|une?|one|two|deux|trois|three)\s+(?:heures?|hours?|minutes?)\b|\b(?:(?:pas\s+avant|not\s+before|on)?\s*(?:next\s+)?(?:vendredi|samedi|dimanche|lundi|mardi|mercredi|jeudi|friday|saturday|sunday|monday|tuesday|wednesday|thursday))\b/u;

/** A condition blocks a contextual reply only when it belongs to the same
 * sentence as a reply/send directive. A later, independent style sentence
 * such as "If useful, keep it concise" must not revoke an already explicit
 * send request. */
function hasContextualReplyUnsatisfiedCondition(rawText: string): boolean {
  return requestClauses(rawText).some(rawClause => {
    // "If it has not already been sent" is an idempotency guard, not a
    // deferred approval or an unknown third-party condition. The connector's
    // signed preflight and exact-once ledger still bind the eventual action.
    const normalizedClause = normalizeForMatch(rawClause);
    if (CONTEXTUAL_REPLY_POSITIVE_EXISTENCE_NO_RESEND.test(normalizedClause)) return false;
    const clause = normalizedClause
      .replace(CONTEXTUAL_REPLY_IDEMPOTENT_SEND_CONDITION, ' ');
    return CONTEXTUAL_REPLY_UNSATISFIED_CONDITION.test(clause)
      && (CONTEXTUAL_REPLY_VERB.test(clause)
        || CONTEXTUAL_SEND_VERB.test(clause)
        || CONTEXTUAL_REPLY_PREPARATION.test(clause));
  });
}

function isCanonicalContextualGmailReplyInput(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const allowedKeys = toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    ? CONTEXTUAL_GMAIL_REPLY_ALL_KEYS
    : CONTEXTUAL_GMAIL_REPLY_KEYS;
  if (!(toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
      || toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL)
    || Object.keys(input).some(key => !allowedKeys.has(key))
    || typeof input.messageId !== 'string'
    || !GMAIL_MESSAGE_ID.test(input.messageId.trim())
    || input.messageId !== input.messageId.trim()
    || typeof input.body !== 'string'
    || input.body.trim().length === 0
    || /\0/u.test(input.body)
    || typeof input.recipientBinding !== 'string'
    || !/^v1\.[0-9]{10}\.[0-9a-f]{64}$/iu.test(input.recipientBinding)
    || toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
      && (typeof input.expectedRecipientEmail !== 'string'
        || input.expectedRecipientEmail !== input.expectedRecipientEmail.trim().toLowerCase()
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedRecipientEmail))
    || toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
      && input.expectedRecipientEmail !== undefined
    || input.expectedSenderEmail !== undefined
      && (typeof input.expectedSenderEmail !== 'string'
        || input.expectedSenderEmail !== input.expectedSenderEmail.trim().toLowerCase()
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedSenderEmail))
    || input.isHtml !== undefined && typeof input.isHtml !== 'boolean') return false;
  for (const key of ['_displayName', '_intent'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || /\0/u.test(input[key]))) {
      return false;
    }
  }
  return true;
}

export type ContextualGmailReplyScope = 'reply' | 'reply-all';

interface ContextualGmailReplyObjective {
  scope: ContextualGmailReplyScope;
  rawRequest: string;
  constraintRequests: readonly string[];
  requiresExactEffectReconciliation: boolean;
}

function hasClosedExactContextualGmailReplyContract(
  objective: ContextualGmailReplyObjective,
): boolean {
  const constraints = contextualGmailResolvedConstraints(objective);
  return objective.scope === 'reply'
    && !constraints.invalid
    && contextualGmailHasStrictClosedFields(objective.rawRequest)
    && constraints.messageIds.length === 1
    && constraints.recipients.length === 1
    && constraints.senders.length === 1
    && constraints.subjects.length === 1
    && constraints.cc === ''
    && constraints.body !== undefined;
}

/**
 * A host-validated affirmative answer can authorize several Gmail replies in
 * one choice. Project only the current preflight/reply target into the
 * single-target policy grammar; the full objective remains the receipt
 * fingerprint. The signed preflight and a separately observed Gmail read
 * still bind this target to its actual thread and recipients.
 */
export function contextualGmailTargetScopedAuthorizationSegments(
  objectiveSegments: readonly string[],
  authenticatedUserAuthorizationSegments: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): readonly string[] {
  if (![
    CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_TOOL,
    CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_TOOL,
  ].includes(toolName)) return objectiveSegments;
  const messageId = typeof input.messageId === 'string'
    ? input.messageId.trim().toLowerCase() : '';
  const recipient = typeof input.expectedRecipientEmail === 'string'
    ? input.expectedRecipientEmail.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{12,32}$/u.test(messageId)
    || !hasSingleMailboxShape(recipient)) return objectiveSegments;
  const latest = authenticatedUserAuthorizationSegments.at(-1);
  if (!latest || objectiveSegments.at(-1) !== latest) return objectiveSegments;
  const latestGrant = parseHostAuthenticatedUserAuthorization(latest);
  if (!latestGrant) return objectiveSegments;
  const latestScope = normalizeForMatch(
    latestGrant.selection + ' ' + latestGrant.displayedScope,
  );
  if (!/\b(?:repondre|reply|answer)\b/u.test(latestScope)
    || CONTEXTUAL_REPLY_NEGATION.test(latestScope)) return objectiveSegments;
  const ids = contextualGmailMessageIds(latestGrant.selection);
  if (ids.length > 0 && !ids.includes(messageId)) return objectiveSegments;
  const recipientGrant = [...authenticatedUserAuthorizationSegments].reverse()
    .map(parseHostAuthenticatedUserAuthorization)
    .find(grant => grant && /\b(?:repondre|reply|answer)\b/u.test(
      normalizeForMatch(grant.selection),
    ) && /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(grant.selection));
  if (!recipientGrant) return objectiveSegments;
  const selectedRecipients = recipientGrant.selection.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  )?.map(email => email.toLowerCase()) ?? [];
  if (!selectedRecipients.includes(recipient)
    || new Set(selectedRecipients).size !== selectedRecipients.length
    || ids.length > 0
      && (ids.length !== selectedRecipients.length
        || ids.indexOf(messageId) !== selectedRecipients.indexOf(recipient))) {
    return objectiveSegments;
  }
  const anchor = ids.length > 0 ? ` MessageId: ${messageId}.` : '';
  return [...objectiveSegments,
    `Réponds dans ce fil Gmail. Cible exacte: ${recipient}.${anchor}`];
}

function contextualGmailReplyObjective(
  objectiveSegments: readonly string[],
): ContextualGmailReplyObjective | undefined {
  const constraintRequests: string[] = [];
  let requiresPriorClosedExactEffect = false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRoutingRequest = normalizeForMatch(contextualGmailRoutingText(rawRequest));
    const normalizedRequest = normalizedRoutingRequest;
    if (!normalizedRoutingRequest) continue;
    if (hasGlobalExternalActionRevocation(contextualGmailRoutingText(rawRequest))) return undefined;
    if (isTargetFreeGenericContinuation(normalizedRoutingRequest)) continue;

    const preparesReply = CONTEXTUAL_REPLY_PREPARATION.test(normalizedRoutingRequest);
    const namesReply = CONTEXTUAL_REPLY_VERB.test(normalizedRoutingRequest);
    const namesThreadBoundSend = CONTEXTUAL_SEND_VERB.test(normalizedRoutingRequest)
      && CONTEXTUAL_REPLY_THREAD.test(normalizedRoutingRequest);
    const namesContextualScope = CONTEXTUAL_REPLY_PRONOUN.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_THREAD.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)
      || contextualGmailTargetEmails(rawRequest).length > 0
      || contextualGmailMessageIds(rawRequest).length > 0
      || preparesReply;
    const namesExternalSend = namesReply || CONTEXTUAL_SEND_VERB.test(normalizedRoutingRequest)
      || preparesReply;
    const continuesPriorExactEffect = (
      CONTEXTUAL_REPLY_CONCLUSIVE_ABSENCE_CONTINUATION.test(normalizedRoutingRequest)
      || CONTEXTUAL_REPLY_STRUCTURED_EXACT_EFFECT_CONTINUATION.test(normalizedRoutingRequest)
    ) && contextualGmailMessageIds(rawRequest).length === 1;
    const exactEffectContinuation = continuesPriorExactEffect
      || CONTEXTUAL_REPLY_EXACT_EFFECT_CONTINUATION.test(normalizedRoutingRequest);
    const blockingRoutingText = continuesPriorExactEffect
      ? requestClauses(contextualGmailRoutingText(rawRequest))
        .filter(clause => {
          const normalizedClause = normalizeForMatch(clause);
          return !CONTEXTUAL_REPLY_DUPLICATE_AMBIGUITY_NO_SEND.test(normalizedClause)
            && !CONTEXTUAL_REPLY_SENT_DRAFTS_RECONCILIATION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_BOUND_EXECUTION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_RECONCILIATION.test(normalizedClause)
            && !CONTEXTUAL_REPLY_STRUCTURED_UNCERTAIN_RESULT.test(normalizedClause);
        })
        .join('. ')
      : contextualGmailRoutingText(rawRequest);
    const normalizedBlockingRequest = normalizeForMatch(blockingRoutingText);
    const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(
      contextualGmailRoutingText(rawRequest),
    );
    const audienceRoutingText = continuesPriorExactEffect && structuredImmutablePayload
      ? contextualGmailStructuredImmutableControlText(rawRequest)
      : contextualGmailRoutingText(rawRequest);
    let audienceMutationText = normalizeForMatch(audienceRoutingText)
      .replace(CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE, ' ')
      .replace(CONTEXTUAL_REPLY_NON_AUDIENCE_CONSTRAINT, ' ')
      .replace(CONTEXTUAL_REPLY_DUPLICATE_CHECK, ' ')
      .replace(CONTEXTUAL_REPLY_SIGNED_PREFLIGHT_FIELDS, ' ');
    if (continuesPriorExactEffect) {
      // In the closed exact-once continuation, `au plus une unique réponse`
      // limits operation cardinality. It is not the generic audience-change
      // construction `plus <recipient>` and must not revoke the prior exact
      // Gmail contract after the host has proved Sent + Drafts absence.
      audienceMutationText = audienceMutationText.replace(
        /\bau\s+plus\s+un(?:e)?\s+unique\s+(?:reponse|gmail\s+reply\s+bound)\b/gu,
        ' ',
      );
    }
    // A recipient-bound reply is closed to one To address and no Cc by both
    // its schema and signed preflight. `CC vide` documents that invariant; it
    // is not an instruction to remove recipients from a reply-all thread.
    if (!CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)) {
      audienceMutationText = audienceMutationText.replace(/\bcc\s+(?:vide|empty|none)\b/gu, ' ');
    }
    let retargetDetectionText = audienceMutationText;
    const routingRequest = contextualGmailRoutingText(rawRequest);
    for (const pattern of [
      /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    ]) {
      for (const match of routingRequest.matchAll(pattern)) {
        retargetDetectionText = retargetDetectionText.replace(normalizeForMatch(match[0]), ' ');
      }
    }
    const explicitRetarget = CONTEXTUAL_REPLY_EXPLICIT_RETARGET.test(
      normalizedRoutingRequest.replace(
        CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE,
        ' ',
      ),
    )
      || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(audienceRoutingText)
        && /\b(?:instead|plutot|rather|recipient|destinataire)\b/u.test(retargetDetectionText);

    const blocksContextualReply = isNonAuthorizingRequest(
      contextualGmailRoutingText(rawRequest),
      normalizedRoutingRequest,
    )
      || CONTEXTUAL_REPLY_NEGATION.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_THREAD_REJECTION.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_CONFIRMATION_BOUNDARY.test(normalizedRequest)
      || CONTEXTUAL_REPLY_DEFERRED_BOUNDARY.test(normalizedRequest)
      || CONTEXTUAL_REPLY_AUDIENCE_CHANGE.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NAMED_AUDIENCE_CHANGE.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NAMED_AUDIENCE_REMOVAL.test(audienceMutationText)
      || CONTEXTUAL_REPLY_NO_SEND_BOUNDARY.test(normalizedBlockingRequest)
      || CONTEXTUAL_REPLY_REPORTED_SPEECH.test(normalizedRequest)
      || CONTEXTUAL_REPLY_META_INSTRUCTION.test(normalizedRequest)
      || /(?:^|\r?\n)(?:[ \t]{4,}|\s*(?:(?:[-*+]\s+|\d+[.)]\s+)?(?:```|~~~|>)|<\/?(?:blockquote|pre|code)\b))/iu.test(
        contextualGmailRoutingText(rawRequest),
      )
      || /^\s*[«“"]/.test(rawRequest) && /[»”"]\s*$/.test(rawRequest)
      || CONTEXTUAL_REPLY_NON_DIRECTIVE.test(normalizedRequest)
      || CONTEXTUAL_REPLY_REPLACED_BY_READ_ONLY.test(normalizedRequest)
      || hasContextualReplyUnsatisfiedCondition(blockingRoutingText)
      || preparesReply
      || EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION.test(normalizedRequest)
      || EXPLICIT_ACTION_AFTER_CONFIRMATION.test(normalizedRequest)
      || explicitRetarget;

    // Accepted amendments are additive by default. An unrelated additional
    // task must not silently discard an already authorized pending reply, but
    // an explicit wait, analysis-only, draft, negation, retarget, or approval
    // boundary still owns and closes the newer authority boundary.
    if (!namesExternalSend && !explicitRetarget) {
      if (blocksContextualReply) return undefined;
      if (contextualGmailExactConstraintSegment(rawRequest)) {
        constraintRequests.unshift(rawRequest);
      }
      continue;
    }
    // This wording explicitly depends on the exact effect "authorized in this
    // chat". Preserve its one anchor as an additive constraint, then require a
    // preceding authenticated reply objective to supply the closed payload.
    // With no preceding authority, or with a conflicting anchor, resolution
    // remains fail-closed.
    if (!blocksContextualReply && continuesPriorExactEffect) {
      // A restart can be self-contained instead of inheriting an earlier
      // segment. Admit that shape only when this same authenticated segment
      // explicitly orders the reply and closes every externally visible
      // field needed by the recipient-bound schema. A deictic continuation
      // such as "reprends" still follows the prior-segment path below.
      if (namesReply && namesContextualScope) {
        const standaloneObjective: ContextualGmailReplyObjective = {
          scope: CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest)
            ? 'reply-all'
            : 'reply',
          rawRequest,
          constraintRequests,
          requiresExactEffectReconciliation: true,
        };
        return hasClosedExactContextualGmailReplyContract(standaloneObjective)
          ? standaloneObjective
          : undefined;
      }
      constraintRequests.unshift(rawRequest);
      requiresPriorClosedExactEffect = true;
      continue;
    }
    if (!namesReply && !namesThreadBoundSend
      && CONTEXTUAL_UNRELATED_ADDITIONAL_SEND.test(normalizedRequest)
      && !blocksContextualReply) continue;
    // A later duplicate-safe instruction may authorize execution of the exact
    // reply already bound by the preceding authenticated segment without
    // restating its target or payload. Inherit only this closed grammar; an
    // ordinary target-free send/reply directive remains fail-closed below.
    if (!blocksContextualReply && !namesContextualScope && exactEffectContinuation) continue;
    if (blocksContextualReply
      || !namesContextualScope
      || !namesReply && !namesThreadBoundSend) return undefined;
    const objective: ContextualGmailReplyObjective = {
      scope: CONTEXTUAL_REPLY_ALL_SCOPE.test(normalizedRoutingRequest) ? 'reply-all' : 'reply',
      rawRequest,
      constraintRequests,
      requiresExactEffectReconciliation: requiresPriorClosedExactEffect,
    };
    if (requiresPriorClosedExactEffect
      && !hasClosedExactContextualGmailReplyContract(objective)) return undefined;
    return objective;
  }
  return undefined;
}

function contextualGmailReplyObjectiveScope(
  objectiveSegments: readonly string[],
): ContextualGmailReplyScope | undefined {
  return contextualGmailReplyObjective(objectiveSegments)?.scope;
}

function contextualGmailBodyMaskedText(rawRequest: string): string {
  const span = contextualGmailExactBodySpan(rawRequest);
  return span
    ? `${rawRequest.slice(0, span.start)} ${rawRequest.slice(span.end)}`
    : rawRequest;
}

function contextualGmailRoutingText(rawRequest: string): string {
  // Exact body and subject payloads are data, not control language. Preserve
  // their structural labels for constraint parsing while masking values such
  // as "Reply all", "Do not send", email addresses or hex-like ids.
  const masked = contextualGmailBodyMaskedText(rawRequest)
    // This inline-code identifier documents the connector schema; camel-case
    // normalization must not turn `replyTo` into the instruction "reply to".
    // Natural-language reply/thread directives remain authority-bearing.
    .replace(CONTEXTUAL_GMAIL_INLINE_REPLY_TO_FIELD, '[schema field]')
    .replace(
      /(\b(?:sujet|subject)(?:\s+exact)?\s*(?::|=)?\s*)(?:«[^«»\r\n]{1,998}»|“[^“”\r\n]{1,998}”|"[^"\r\n]{1,998}"|`[^`\r\n]{1,998}`)/giu,
      '$1[exact subject]',
    )
    .replace(
      /(\b(?:sujet|subject)\s+exact\s*(?::|=)\s*)(?![«“"`])([^\r\n]{1,998}?)(?=(?:[ \t]*[.;][ \t]*|[ \t]*\r?\n[ \t]*)(?:(?:corps|body|texte|text|message)\s+exact|exact\s+(?:body|text|message))\b)/giu,
      '$1[exact subject]',
    );
  if (!CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(masked)) {
    return masked;
  }
  // In the closed structured format, the subject line is immutable payload
  // data. Do not let words such as “signature”, “attachments”, “HTML” or “do
  // not send” inside that value become routing/control instructions. The
  // exact-subject parser intentionally reads the unmasked request separately.
  return masked.replace(
    /(^|\r?\n)([ \t]*[-*][ \t]*(?:sujet|subject)[ \t]*:[ \t]*)[^\r\n]{1,998}/giu,
    '$1$2[exact subject]',
  );
}

/** Mask declarations and post-send audit fields from the control-language
 * detectors once a structured immutable payload has been recognized. Those
 * fields still feed the exact constraint parser; they simply must not be
 * mistaken for a second audience change or a request to attach/sign content. */
function contextualGmailStructuredImmutableControlText(
  rawRequest: string,
  maskPayloadDeclarations = true,
): string {
  const routingText = contextualGmailRoutingText(rawRequest);
  if (!CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(routingText)) {
    return routingText;
  }
  const withoutPayloadDeclarations = maskPayloadDeclarations
    ? routingText.replace(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:from|sender|exp[ée]diteur|to|cc|bcc|cci|sujet|subject|texte\s+brut|plain\s+text|pi[eè]ces?\s+jointes?|attachments?|signature|corps\s+exact|exact\s+body)\b[^\r\n]*/giu,
      '\n',
    )
    : routingText;
  return withoutPayloadDeclarations
    .replace(
      /\b(?:continue\s+uniquement\s+si\b(?=[^.!?\r\n]{0,1200}\br[ée]conciliation\s+sent\s+et\s+draft\b)|continue\s+only\s+if\b(?=[^.!?\r\n]{0,1200}\bsent\s+and\s+draft\s+reconciliation\b))(?=[^.!?\r\n]{0,1200}\b(?:enti[eè]rement\s+pagin[ée]e|fully\s+paginated)\b)(?=[^.!?\r\n]{0,1200}\bcandidate\s*count\b[^0-9\r\n]{0,10}0\b)[^.!?\r\n]{1,1200}/giu,
      ' ',
    )
    .replace(
      /\b(?:apr[èe]s\s+l['’]\s*appel\s*,?\s*v[ée]rifie(?:z)?\s+par\s+api|after\s+the\s+call\s*,?\s*verify\s+via\s+(?:the\s+)?api)\b[^.!?\r\n]{0,700}\b(?:absence\s+de\s+signature|no\s+signature)\b/giu,
      ' ',
    );
}

function contextualGmailMessageIds(rawRequest: string): string[] {
  const values: string[] = [];
  const routingText = contextualGmailRoutingText(rawRequest);
  for (const match of routingText.matchAll(
    /\b(?:message(?:\s*id)?|messageid|ancre|ancr[ée](?:e)?|anchor(?:ed)?|fil\s+gmail|gmail\s+(?:thread|message))(?=$|\s|[:=#-])(?:\s+(?:exacte?|exact))?\s*(?:sur|on)?\s*(?::|=|#|-)?\s*`?([0-9a-f]{12,32})`?/giu,
  )) {
    if (match[1]) values.push(match[1].toLowerCase());
  }
  return [...new Set(values)];
}

function contextualGmailTargetEmails(rawRequest: string): string[] {
  const routingText = contextualGmailRoutingText(rawRequest);
  const recipients: string[] = [];
  for (const match of routingText.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)) {
    const index = match.index ?? 0;
    const rawPrefix = routingText.slice(Math.max(0, index - 220), index);
    const prefix = normalizeForMatch(rawPrefix);
    // The bound reply schema cannot select a sender identity. Do not mistake
    // explicit audit metadata (`Cible exacte: recipient, From sender`) for a
    // second target recipient. Keep a standalone "mail from Alice" address
    // target-bound rather than silently broadening that ordinary instruction.
    const precedingText = routingText.slice(0, index);
    const hasExplicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText)
      || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText);
    const explicitSenderMetadata = /(?:^|\s)(?:(?:from|sender|exp[ée]diteur(?:\s+exact)?)\s*(?::|=)|(?:depuis|expectedsenderemail)\s*(?::|=)?)\s*`?\s*$/iu.test(rawPrefix);
    if (explicitSenderMetadata || hasExplicitRecipientMetadata
      && /(?:^|\s)(?:from|sender|expediteur)\s*$/u.test(prefix)) continue;
    const explicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*$/u.test(prefix)
      || /(?:^|[\s,;])to\s*(?::|=)?\s*$/u.test(prefix);
    const directReplyRecipient = /\b(?:reply|respond|answer|write\s+back|send|reponds?|repondez|repondre|envoie|envoyer|transmets?|transmettre)\b[^.!?;\r\n]{0,180}\b(?:to|a|vers|from|de)\s*$/u.test(prefix)
      && !/\b(?:contact|adresse)\s+(?:de\s+)?reference\b[^.!?;\r\n]{0,40}$/u.test(prefix);
    if (!explicitRecipientMetadata && !directReplyRecipient) continue;
    recipients.push(match[0].toLowerCase());
  }
  return [...new Set(recipients)];
}

/** Extract only explicit sender metadata. This is deliberately separate from
 * recipient discovery: a `From` address must never become a reply target, but
 * when the human names it the closed preflight must bind the authenticated
 * Gmail profile to that exact identity before a send can inherit authority. */
function contextualGmailExpectedSenderEmails(rawRequest: string): string[] {
  const routingText = contextualGmailRoutingText(rawRequest);
  const senders: string[] = [];
  for (const match of routingText.matchAll(
    /(?:^|[.,;\n]|[ \t]+)(from|sender|exp[ée]diteur(?:\s+exact)?|depuis|expectedsenderemail)[ \t]*(:|=)?[ \t]*`?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/giu,
  )) {
    const precedingText = routingText.slice(0, match.index ?? 0);
    const followsExplicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText)
      || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText);
    // Preserve the historical natural-language meaning of "mail from Alice"
    // unless `From:` is explicitly metadata or follows an exact recipient
    // field in the same operational instruction.
    const senderLabel = normalizeForMatch(match[1] ?? '');
    if (match[2] !== undefined || senderLabel === 'depuis'
      || senderLabel === 'expectedsenderemail' || followsExplicitRecipientMetadata) {
      senders.push(match[3]!.toLowerCase());
    }
  }
  return [...new Set(senders)];
}

function latestContextualGmailMention(objectiveSegments: readonly string[]): string | undefined {
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(contextualGmailRoutingText(rawRequest));
    if (!normalizedRequest || isTargetFreeGenericContinuation(normalizedRequest)) continue;
    const namesReply = CONTEXTUAL_REPLY_VERB.test(normalizedRequest);
    const preparesReply = CONTEXTUAL_REPLY_PREPARATION.test(normalizedRequest);
    const namesThreadBoundSend = CONTEXTUAL_SEND_VERB.test(normalizedRequest)
      && CONTEXTUAL_REPLY_THREAD.test(normalizedRequest);
    const namesContextualScope = CONTEXTUAL_REPLY_PRONOUN.test(normalizedRequest)
      || CONTEXTUAL_REPLY_THREAD.test(normalizedRequest)
      || contextualGmailTargetEmails(rawRequest).length > 0
      || contextualGmailMessageIds(rawRequest).length > 0;
    if ((namesReply || namesThreadBoundSend || preparesReply)
      && (namesContextualScope || preparesReply)) return rawRequest;
  }
  return undefined;
}

/** Parse complete body envelopes in one pass, rejecting nested or unclosed markers. */
function gmailBodyEnvelopeSpans(text: string): Array<{ body: string; start: number; end: number }> | null {
  const spans: Array<{ body: string; start: number; end: number }> = [];
  let start: number | undefined;
  for (const marker of text.matchAll(/^[ \t]*BODY_(BEGIN|END)[ \t]*\r?$/gimu)) {
    if (marker[1]!.toUpperCase() === 'BEGIN') {
      if (start !== undefined) return null;
      start = marker.index + marker[0].length + 1;
      if (text[start - 1] !== '\n') return null;
    } else {
      if (start === undefined || marker.index <= start) return null;
      const end = marker.index - (text[marker.index - 2] === '\r' ? 2 : 1);
      spans.push({ body: text.slice(start, end), start, end });
      start = undefined;
    }
  }
  return start === undefined ? spans : null;
}

function contextualGmailExactBodySpan(
  rawRequest: string,
): { body: string; start: number; end: number } | null | undefined {
  const unquotedBodySpan = (
    bodyStart: number,
  ): { body: string; start: number; end: number } | null => {
    const tail = rawRequest.slice(bodyStart);
    const explicitInstructionLine = /(?:^|\r?\n)[ \t]*(?=(?:next\s+instruction\s*:|instruction\s+suivante\s*:|cet\s+envoi\s+exact\s+est\s+d[ée]j[àa]\s+autoris[ée]|this\s+exact\s+send\s+is\s+already\s+authori[sz]ed|s(?:['’]\s*)?il\s+n(?:['’]\s*)?est\s+pas\s+d[ée]j[àa]\s+envoy[ée](?=$|[\s,.;!?])(?=[^\r\n]{0,200}\bpr[ée]flight\b)(?=[^\r\n]{0,260}\b(?:outil|tool|gmail_reply)\b)))/giu;
    const ambiguousInstructionLikeLine = /(?:^|\r?\n)[ \t]*(?=(?:v[ée]rifie(?:z)?\b|(?:puis|ensuite)\s+(?:v[ée]rifie(?:z)?|poursui(?:s|vez)|continue(?:z)?|termine(?:z)?)\b|apr[èe]s\s+(?:l['’]\s*envoi|avoir\s+envoy[ée])(?:$|[\s,.;!?])|then\s+(?:verify|continue|finish|complete)\b|next\s+(?:verify|continue|finish|complete)\b|after\s+sending\b|verify\s+(?:afterwards|next)\b))/giu;
    const boundary = explicitInstructionLine.exec(tail);
    const ambiguousBoundary = ambiguousInstructionLikeLine.exec(tail);
    // An unquoted body containing instruction-shaped prose is ambiguous. Do
    // not silently truncate it and authorize a different payload; require an
    // explicit structural marker (or quoted delimiters) from the human.
    if (ambiguousBoundary && (!boundary || ambiguousBoundary.index < boundary.index)) return null;
    const bodyEnd = boundary ? bodyStart + boundary.index : rawRequest.length;
    const body = rawRequest.slice(bodyStart, bodyEnd).trim();
    return body && body.length <= 4000 ? { body, start: bodyStart, end: bodyEnd } : null;
  };
  // Accept one explicit machine-readable body envelope. Operational recovery
  // prompts use this form so exact content can contain quotes and line breaks
  // without making the following instructions part of the message body.
  const bodyBlocks = gmailBodyEnvelopeSpans(rawRequest);
  if (!bodyBlocks || bodyBlocks.length > 1) return null;
  const bodyBlock = bodyBlocks[0];
  if (bodyBlock) {
    if (!bodyBlock.body.trim() || bodyBlock.body.length > 4000) return null;
    return bodyBlock;
  }
  const exactness = /\b(?:(?:corps|texte|message|body|text)\s+exact|exactement\s+(?:ce|le)\s+(?:corps|texte|message)|exact\s+(?:body|text|message)|exactly\s+(?:this|the)\s+(?:body|text|message))\b/giu;
  const labels = [...rawRequest.matchAll(exactness)];
  if (labels.length > 1) return null;
  const label = labels[0];
  if (label) {
    const tailOffset = label.index + label[0].length;
    const tail = rawRequest.slice(tailOffset);
    const unquotedBlock = /^[ \t]*:[ \t]*\r?\n/u.exec(tail);
    if (unquotedBlock) return unquotedBodySpan(tailOffset + unquotedBlock[0].length);
    const match = /«([\s\S]{1,4000}?)»|“([\s\S]{1,4000}?)”|"([\s\S]{1,4000}?)"/u.exec(tail);
    if (!match) return null;
    if (!/^[\s:=\-–—]*$/u.test(tail.slice(0, match.index))) return null;
    const delimiter = match[0][0];
    const sameLineRemainder = tail
      .slice(match.index + match[0].length)
      .split(/\r?\n/u, 1)[0] ?? '';
    const hasAnotherSameLineDelimiter = delimiter === '«'
      ? /«|»/u.test(sameLineRemainder)
      : delimiter === '“'
        ? /“|”/u.test(sameLineRemainder)
        : /"/u.test(sameLineRemainder);
    // A second delimited value on the exact-body line is ambiguous. Quoted
    // prose on a later instruction line is outside the field and must not make
    // the already closed body unparsable.
    if (hasAnotherSameLineDelimiter) return null;
    const body = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return body ? {
      body,
      start: tailOffset + match.index,
      end: tailOffset + match.index + match[0].length,
    } : null;
  }

  // Operational prompts often provide the approved payload as a multiline
  // block rather than quoted prose. Recognize only the narrow, imperative
  // `envoie exactement:` / `send exactly:` form followed by a newline. The
  // block ends at the objective-segment boundary or before an unmistakable
  // next-instruction line; broad labels such as `message:` remain unsupported
  // so surrounding instructions cannot silently become email content.
  const blockLabel = /\b(?:envoie|envoyez|send)\s+exactement\s*:[ \t]*(?:\r?\n)/iu.exec(rawRequest)
    ?? /\bsend\s+exactly\s*:[ \t]*(?:\r?\n)/iu.exec(rawRequest);
  if (!blockLabel) return undefined;
  const bodyStart = blockLabel.index + blockLabel[0].length;
  return unquotedBodySpan(bodyStart);
}

function contextualGmailExactBody(rawRequest: string): string | null | undefined {
  const span = contextualGmailExactBodySpan(rawRequest);
  if (span === null || span === undefined) return span;
  const labelLineStart = rawRequest.lastIndexOf('\n', span.start) + 1;
  const labelLine = normalizeForMatch(rawRequest.slice(labelLineStart, span.start));
  const genericPayloadLabel = /\b(?:texte|message|text)\s+exact\b|\bexact\s+(?:text|message)\b/u.test(labelLine);
  if (genericPayloadLabel
    && /\b(?:slack|sms|teams|whatsapp|notification|rapport|report)\b/u.test(labelLine)
    && !/\b(?:gmail|e\s*mail|email|courriel|reply|reponse|repond)\b/u.test(labelLine)) {
    return undefined;
  }
  return span.body;
}

function contextualGmailExpectedSubjects(rawRequest: string): string[] {
  const routingText = contextualGmailBodyMaskedText(rawRequest);
  const subjects: string[] = [];
  for (const match of routingText.matchAll(
    /\b(?:sujet|subject)(?:[ \t]{1,256}exact)?[ \t]{0,256}(?::|=)?[ \t]{0,256}(?:«([^«»\r\n]{1,998})»|“([^“”\r\n]{1,998})”|"([^"\r\n]{1,998})"|`([^`\r\n]{1,998})`)/giu,
  )) {
    const subject = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (subject) subjects.push(subject);
  }
  // An unquoted subject is accepted only behind the explicit `subject exact`
  // label and before another exact field on the same line. This keeps the
  // boundary structural instead of guessing where ordinary prose ends.
  for (const match of routingText.matchAll(
    /\b(?:sujet|subject)[ \t]{1,256}exact[ \t]{0,256}(?::|=)[ \t]{0,256}(?![«“"`])([^\r\n]{1,998}?)(?=(?:[ \t]*[.;][ \t]*|[ \t]*\r?\n[ \t]*)(?:(?:corps|body|texte|text|message)[ \t]{1,256}exact|exact[ \t]{1,256}(?:body|text|message))\b)/giu,
  )) {
    const subject = (match[1] ?? '').trim();
    if (subject) subjects.push(subject);
  }
  // A structured immutable payload makes each field value exact even when
  // the individual label omits the word "exact".
  if (CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(routingText)) {
    for (const match of routingText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:sujet|subject)[ \t]*:[ \t]*([^\r\n]{1,998})/giu,
    )) {
      const subject = (match[1] ?? '').trim();
      if (subject) subjects.push(subject);
    }
  }
  return [...new Set(subjects)];
}

function contextualGmailExpectedCc(rawRequest: string): string | undefined {
  const routingText = contextualGmailRoutingText(rawRequest);
  const explicitFields = [...routingText.matchAll(
    /(?:^|\r?\n)[ \t]*[-*]?[ \t]*(?:cc|copie)[ \t]*(?::|=)[ \t]*([^\r\n]{1,500})/giu,
  )];
  const explicitEmails = explicitFields.flatMap(match => (
    match[1]?.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
      ?.map(email => email.toLowerCase()) ?? []
  ));
  if (explicitEmails.length) return [...new Set(explicitEmails)].sort().join(', ');
  const explicitlyEmpty = /\b(?:cc|copie)\s*(?::|=)?\s*(?:vide|empty|none|aucune?|sans\s+destinataire)\b/iu.test(routingText)
    || /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:cc|copie)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/iu.test(routingText);
  if (explicitlyEmpty) {
    return '';
  }
  const field = /\bcc\s*(?::|=)\s*([^.;\r\n]{1,500})/iu.exec(routingText)?.[1];
  if (!field) return undefined;
  const emails = field.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  return emails.length ? [...new Set(emails)].sort().join(', ') : undefined;
}

function contextualGmailHasSingleEmptyStructuredAudienceField(
  rawRequest: string,
  field: 'cc' | 'bcc',
): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const pattern = field === 'cc'
    ? /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:cc|copie)[ \t]*:[ \t]*([^\r\n]*)/giu
    : /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:bcc|cci)[ \t]*:[ \t]*([^\r\n]*)/giu;
  const values = [...routingText.matchAll(pattern)].map(match => match[1]?.trim() ?? '');
  return values.length === 1 && values[0] === '[]';
}

function contextualGmailExactConstraintSegment(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const exactBody = contextualGmailExactBody(rawRequest);
  const exactBodyApplies = exactBody !== undefined && (
    /\b(?:corps\s+exact|exact\s+body|exactement\s+(?:ce|le)\s+corps|exactly\s+(?:this|the)\s+body)\b/iu.test(routingText)
    || /\b(?:gmail|e-?mail|courriel|reply|reponse|repond|fil\s+gmail|messageid)\b/iu.test(routingText)
  );
  return exactBodyApplies
    || contextualGmailExpectedSubjects(rawRequest).length > 0
    || contextualGmailExpectedCc(rawRequest) !== undefined
    || contextualGmailExpectedSenderEmails(rawRequest).length > 0
    || /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient)|messageid\s*(?::|=)|ancre\s+exacte|exact\s+anchor)\b/iu.test(routingText)
    || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText);
}

function contextualGmailHasNegatedExactField(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const field = /\b(?:message\s*id|messageid|ancre|anchor|fil\s+gmail|gmail\s+(?:thread|message)|cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient)|from|sender|expediteur|cc|copie|sujet|subject|corps\s+exact|body\s+exact|exact\s+body)\b/u;
  const negative = /\b(?:do\s+not\s+use|don\s+t\s+use|must\s+not\s+use|never\s+use|n\s+utilise\s+pas|ne\s+pas\s+utiliser|interdit|interdite|forbidden|prohibited|exclude|exclure)\b/u;
  return requestClauses(routingText).some(clause => {
    const normalized = normalizeForMatch(clause);
    return field.test(normalized) && negative.test(normalized);
  });
}

function contextualGmailHasUnsupportedExactEffectRequirement(rawRequest: string): boolean {
  const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(
    contextualGmailRoutingText(rawRequest),
  );
  const structuredControlText = contextualGmailStructuredImmutableControlText(rawRequest, false);
  const exactStructuredAttachments = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredAttachments = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const exactStructuredSignatures = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[ \t]*(?:aucune|none)(?:[ \t]*,[ \t]*(?:ni\s+automatique\s+ni\s+manuelle|neither\s+automatic\s+nor\s+manual))?[ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredSignatures = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const exactStructuredPlainText = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[ \t]*(?:\([ \t]*`?isHtml=false`?[ \t]*\)|`?isHtml=false`?)[ \t]*(?=$|\r?\n)/giu,
    ),
  ];
  const allStructuredPlainText = [
    ...structuredControlText.matchAll(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[^\r\n]*(?=$|\r?\n)/giu,
    ),
  ];
  const invalidStructuredPayload = structuredImmutablePayload && (
    exactStructuredAttachments.length !== 1
    || allStructuredAttachments.length !== 1
    || exactStructuredSignatures.length !== 1
    || allStructuredSignatures.length !== 1
    || exactStructuredPlainText.length !== 1
    || allStructuredPlainText.length !== 1
    || !contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'bcc')
  );
  const routingText = structuredControlText
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*(?:pi[eè]ces?\s+jointes?|attachments?)[ \t]*:[ \t]*\[\][ \t]*(?=$|\r?\n)/giu, ' ')
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*signature[ \t]*:[ \t]*(?:aucune|none)(?:[ \t]*,[ \t]*(?:ni\s+automatique\s+ni\s+manuelle|neither\s+automatic\s+nor\s+manual))?[ \t]*(?=$|\r?\n)/giu, ' ')
    .replace(/(?:^|\r?\n)[ \t]*[-*][ \t]*(?:texte\s+brut\s+uniquement|plain\s+text\s+only)[ \t]*(?:\([ \t]*`?isHtml=false`?[ \t]*\)|`?isHtml=false`?)[ \t]*(?=$|\r?\n)/giu, ' ');
  let normalized = normalizeForMatch(routingText);
  normalized = normalized
    .replace(/\b(?:sans|without|no)\s+(?:aucune?\s+|any\s+)?(?:pieces?\s+jointes?|attachments?|fichiers?\s+joints?)\b/gu, ' ')
    .replace(/\baucune?\s+(?:pieces?\s+jointes?|attachments?)\s+n\s+est\s+autorisee?\b/gu, ' ')
    .replace(/\babsence\s+de\s+(?:pieces?\s+jointes?|attachments?|fichiers?\s+joints?)\b/gu, ' ')
    .replace(/\b(?:sans|without|no)\s+(?:aucune?\s+|any\s+)?(?:signature|signature\s+automatique)\b/gu, ' ')
    .replace(/\baucune?\s+signature(?:\s+automatique)?\s+n\s+est\s+(?:ajoutee?|autorisee?)\b/gu, ' ')
    .replace(/\babsence\s+de\s+signature(?:\s+automatique)?\b/gu, ' ');
  return invalidStructuredPayload
    || /\b(?:pieces?\s+jointes?|attachments?|attach(?:ed|ment)?|joindre|joins?|fichiers?\s+joints?)\b/u.test(normalized)
    || /\bsignature\b/u.test(normalized)
    || /\b(?:is\s*html|format\s+html|html\s+format|au\s+format\s+html|corps\s+html|html\s+body)\b/u.test(normalized);
}

function contextualGmailHasStrictClosedFields(rawRequest: string): boolean {
  const routingText = contextualGmailRoutingText(rawRequest);
  const normalized = normalizeForMatch(routingText);
  const structuredImmutablePayload = CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(normalized);
  const strictAnchor = /\b(?:message\s*id|messageid|ancre(?:\s+exacte?)?|anchor(?:\s+exact)?|fil\s+gmail|gmail\s+(?:thread|message))\b(?:\s+(?:exacte?|exact))?\s*(?:sur|on)?\s*(?::|=|#|-)?\s*`?[0-9a-f]{12,32}`?/iu.test(routingText);
  const strictRecipient = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText)
    || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText)
    || /\b(?:reply|respond|answer|write\s+back|send|r[ée]ponds?|r[ée]pondez|r[ée]pondre|envoie|envoyer|transmets?|transmettre)\b[^.!?;\r\n]{0,120}\b(?:to|[àa]|vers)\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(routingText);
  const strictSender = contextualGmailExpectedSenderEmails(rawRequest).length === 1;
  const strictEmptyCc = contextualGmailExpectedCc(rawRequest) === ''
    && (!structuredImmutablePayload
      || contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'cc'));
  const strictEmptyBcc = !structuredImmutablePayload
    || contextualGmailHasSingleEmptyStructuredAudienceField(rawRequest, 'bcc');
  const strictSubject = /\b(?:sujet|subject)\s+exact\b/u.test(normalized)
    || structuredImmutablePayload && contextualGmailExpectedSubjects(rawRequest).length === 1;
  const strictBody = /\b(?:corps\s+exact|exact\s+body|body\s+exact|exactement\s+(?:ce|le)\s+corps|exactly\s+(?:this|the)\s+body)\b/u.test(normalized)
    || structuredImmutablePayload
      && gmailBodyEnvelopeSpans(rawRequest)?.length === 1;
  return strictAnchor && strictRecipient && strictSender && strictEmptyCc && strictEmptyBcc
    && strictSubject && strictBody
    && !contextualGmailHasNegatedExactField(rawRequest)
    && !contextualGmailHasUnsupportedExactEffectRequirement(rawRequest);
}

interface ContextualGmailResolvedConstraints {
  requests: readonly string[];
  objectiveRequest: string;
  messageIds: readonly string[];
  recipients: readonly string[];
  senders: readonly string[];
  subjects: readonly string[];
  cc?: string;
  body?: string;
  invalid: boolean;
}

function contextualGmailResolvedConstraints(
  requested: ContextualGmailReplyObjective,
): ContextualGmailResolvedConstraints {
  const requests = [requested.rawRequest, ...requested.constraintRequests];
  const unique = (values: readonly string[]) => [...new Set(values)];
  const messageIds = unique(requests.flatMap(contextualGmailMessageIds)
    .map(value => value.toLowerCase()));
  const recipients = unique(requests.flatMap(contextualGmailTargetEmails));
  const senders = unique(requests.flatMap(contextualGmailExpectedSenderEmails));
  const subjects = unique(requests.flatMap(contextualGmailExpectedSubjects));
  const ccValues = unique(requests
    .map(contextualGmailExpectedCc)
    .filter((value): value is string => value !== undefined));
  const parsedBodies = requests.map(contextualGmailExactBody);
  const bodyValues = unique(parsedBodies
    .filter((value): value is string => typeof value === 'string'));
  const invalid = parsedBodies.some(value => value === null)
    || requests.some(contextualGmailHasNegatedExactField)
    || requests.some(contextualGmailHasUnsupportedExactEffectRequirement)
    || messageIds.length > 1
    || recipients.length > 1
    || senders.length > 1
    || subjects.length > 1
    || ccValues.length > 1
    || bodyValues.length > 1;
  return {
    requests,
    // This key is internal and binds a preflight receipt to every applicable
    // authenticated amendment, not just to the older segment naming reply.
    objectiveRequest: JSON.stringify(requests),
    messageIds,
    recipients,
    senders,
    subjects,
    ...(ccValues.length === 1 ? { cc: ccValues[0] } : {}),
    ...(bodyValues.length === 1 ? { body: bodyValues[0] } : {}),
    invalid,
  };
}

/**
 * Exact externally visible fields explicitly fixed by the current authenticated
 * contextual Gmail objective. Omitted fields are genuinely unspecified; they
 * must not be invented by a completion check. The anchor is a Gmail message
 * id, not a model-selected thread id, so the connector can prove that the
 * candidate sent message belongs to the anchor's actual thread.
 */
export interface ContextualGmailExactEffectExpectation {
  scope: ContextualGmailReplyScope;
  anchorMessageId?: string;
  expectedRecipientEmail?: string;
  expectedSenderEmail?: string;
  expectedCc?: string;
  expectedSubject?: string;
  expectedBody?: string;
  expectedIsHtml?: boolean;
}

export function contextualGmailExactEffectExpectationFromObjective(
  objectiveSegments: readonly string[],
): ContextualGmailExactEffectExpectation | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested) return undefined;
  const constraints = contextualGmailResolvedConstraints(requested);
  if (constraints.invalid) return undefined;
  const {
    messageIds, recipients, senders, subjects, body, cc,
  } = constraints;
  return {
    scope: requested.scope,
    ...(messageIds.length === 1 ? { anchorMessageId: messageIds[0] } : {}),
    ...(requested.scope === 'reply' && recipients.length === 1
      ? { expectedRecipientEmail: recipients[0] } : {}),
    ...(senders.length === 1 ? { expectedSenderEmail: senders[0] } : {}),
    ...(cc !== undefined ? { expectedCc: cc } : {}),
    ...(subjects.length === 1 ? { expectedSubject: subjects[0] } : {}),
    ...(body !== undefined ? { expectedBody: body, expectedIsHtml: false } : {}),
  };
}

/**
 * Narrow capability for replacing a separate Gmail anchor read. This is
 * intentionally stricter than the general exact-effect expectation: the same
 * authenticated objective must close every externally visible field of one
 * recipient-bound plain-text reply and require exact-effect reconciliation.
 */
export function contextualGmailClosedExactEffectExpectationFromObjective(
  objectiveSegments: readonly string[],
): ContextualGmailExactEffectExpectation | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested
    || !requested.requiresExactEffectReconciliation
    || !hasClosedExactContextualGmailReplyContract(requested)) return undefined;
  const expectation = contextualGmailExactEffectExpectationFromObjective(objectiveSegments);
  return expectation?.scope === 'reply'
    && expectation.anchorMessageId !== undefined
    && expectation.expectedRecipientEmail !== undefined
    && expectation.expectedSenderEmail !== undefined
    && expectation.expectedCc === ''
    && expectation.expectedSubject !== undefined
    && expectation.expectedBody !== undefined
    && expectation.expectedIsHtml === false
    ? expectation
    : undefined;
}

/**
 * Host-observed intent for one connector preflight. The connector's signed
 * `recipientBinding` proves that the preflight actually resolved this same
 * closed payload; this record additionally proves that the host saw the
 * resolution attempt under the still-current authenticated human objective.
 */
export interface ContextualGmailReplyPreflightIntent {
  scope: ContextualGmailReplyScope;
  messageId: string;
  body: string;
  isHtml: boolean;
  requiresExactEffectReconciliation: boolean;
  expectedRecipientEmail?: string;
  expectedSenderEmail?: string;
  expectedCc?: string;
  expectedSubject?: string;
  objectiveRequest: string;
}

interface ContextualGmailReplyPreflightAttestationBase
  extends ContextualGmailReplyPreflightIntent {
  recipientBinding: string;
  bindingExpiresAtMs: number;
  preflightToolUseId: string;
}

export type ContextualGmailReplyPreflightAttestation =
  ContextualGmailReplyPreflightAttestationBase & (
    | { anchorEvidence: 'gmail-read'; readToolUseId: string }
    | { anchorEvidence: 'exact-human-objective'; readToolUseId?: never }
  );

export function contextualGmailReplyPreflightAttestationFromObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): ContextualGmailReplyPreflightIntent | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  if (!requested) return undefined;
  const constraints = contextualGmailResolvedConstraints(requested);
  if (constraints.invalid) return undefined;
  const exactEffect = contextualGmailExactEffectExpectationFromObjective(objectiveSegments);
  const expectedTool = requested.scope === 'reply-all'
    ? 'mcp__google-contacts__gmail_reply_all_preflight'
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
  const allowedKeys = requested.scope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_KEYS
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_KEYS;
  if (toolName !== expectedTool
    || Object.keys(input).some(key => !allowedKeys.has(key))
    || typeof input.messageId !== 'string'
    || input.messageId !== input.messageId.trim()
    || !GMAIL_MESSAGE_ID.test(input.messageId)
    || typeof input.body !== 'string'
    || input.body.trim().length === 0
    || /\0/u.test(input.body)
    || input.isHtml !== undefined && typeof input.isHtml !== 'boolean') return undefined;

  const messageId = input.messageId.toLowerCase();
  const objectiveMessageIds = constraints.messageIds;
  if (objectiveMessageIds.length > 1
    || objectiveMessageIds.length === 1
      && objectiveMessageIds[0]!.toLowerCase() !== messageId) return undefined;

  const exactBody = constraints.body;
  if (exactBody !== undefined && (input.body !== exactBody || input.isHtml === true)) {
    return undefined;
  }
  const objectiveEmails = constraints.recipients;
  const objectiveSenderEmails = constraints.senders;
  if (objectiveSenderEmails.length > 1
    || objectiveSenderEmails.length === 0 && input.expectedSenderEmail !== undefined
    || objectiveSenderEmails.length === 1
      && input.expectedSenderEmail !== objectiveSenderEmails[0]) return undefined;
  if (requested.scope === 'reply-all') {
    if (input.expectedRecipientEmail !== undefined || objectiveEmails.length > 0) return undefined;
  } else {
    if (typeof input.expectedRecipientEmail !== 'string'
      || input.expectedRecipientEmail !== input.expectedRecipientEmail.trim().toLowerCase()
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedRecipientEmail)
      || objectiveEmails.length > 1
      || objectiveEmails.length === 1
        && input.expectedRecipientEmail !== objectiveEmails[0]) return undefined;
  }

  return {
    scope: requested.scope,
    messageId,
    body: input.body,
    isHtml: input.isHtml === true,
    requiresExactEffectReconciliation: requested.requiresExactEffectReconciliation,
    ...(requested.scope === 'reply'
      ? { expectedRecipientEmail: String(input.expectedRecipientEmail) }
      : {}),
    ...(objectiveSenderEmails.length === 1
      ? { expectedSenderEmail: objectiveSenderEmails[0] }
      : {}),
    ...(exactEffect?.expectedCc !== undefined
      ? { expectedCc: exactEffect.expectedCc }
      : {}),
    ...(exactEffect?.expectedSubject !== undefined
      ? { expectedSubject: exactEffect.expectedSubject }
      : {}),
    objectiveRequest: constraints.objectiveRequest,
  };
}

function contextualGmailReplyMatchesPreflightAttestation(
  input: Record<string, unknown>,
  requested: ContextualGmailReplyObjective,
  attestation?: ContextualGmailReplyPreflightAttestation,
): boolean {
  const constraints = contextualGmailResolvedConstraints(requested);
  if (!attestation
    || constraints.invalid
    || attestation.scope !== requested.scope
    || attestation.requiresExactEffectReconciliation
      !== requested.requiresExactEffectReconciliation
    || attestation.objectiveRequest !== constraints.objectiveRequest
    || attestation.messageId !== String(input.messageId).toLowerCase()
    || attestation.recipientBinding !== input.recipientBinding
    || attestation.body !== String(input.body)
    || attestation.isHtml !== (input.isHtml === true)
    || attestation.expectedSenderEmail !== input.expectedSenderEmail) return false;
  return requested.scope === 'reply-all'
    ? attestation.expectedRecipientEmail === undefined
    : attestation.expectedRecipientEmail === input.expectedRecipientEmail;
}

/**
 * Bind deictic reply instructions ("reply to them", "dans le fil existant")
 * only to the closed Gmail reply operation. The messageId fixes the existing
 * thread, while the closed schema prevents an agent from adding recipients,
 * attachments, sender overrides, or another routing field.
 */
export function isContextualGmailReplyAuthorizedByObjective(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  preflightAttestation?: ContextualGmailReplyPreflightAttestation,
): boolean {
  if (!isCanonicalContextualGmailReplyInput(toolName, input)) return false;
  const requested = contextualGmailReplyObjective(objectiveSegments);
  const constraints = requested ? contextualGmailResolvedConstraints(requested) : undefined;
  const messageId = String(input.messageId).toLowerCase();
  const objectiveMessageIds = constraints?.messageIds ?? [];
  const objectiveEmails = constraints?.recipients ?? [];
  const objectiveSenderEmails = constraints?.senders ?? [];
  const exactBody = constraints?.body;
  // Only the local bound wrappers supply a short-lived signed capability that
  // binds message/thread, resolved recipient set and body. When the human
  // naturally names "this thread" instead of an API id, the host must also
  // have observed the matching preflight under this exact objective. The
  // legacy plain reply tool cannot inherit this contextual authority.
  const exactHumanAnchor = objectiveMessageIds.length === 1
    && objectiveMessageIds[0]!.toLowerCase() === messageId;
  const hostObservedAnchor = requested !== undefined
    && objectiveMessageIds.length === 0
    && contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    );
  const exactEffectReconciliationAttested = requested !== undefined
    && (!requested.requiresExactEffectReconciliation
      || contextualGmailReplyMatchesPreflightAttestation(
        input,
        requested,
        preflightAttestation,
      ));
  return requested !== undefined
    && constraints !== undefined
    && !constraints.invalid
    && exactEffectReconciliationAttested
    && objectiveMessageIds.length <= 1
    && (exactHumanAnchor || hostObservedAnchor)
    && (exactBody === undefined
      || String(input.body) === exactBody && input.isHtml !== true)
    && objectiveSenderEmails.length <= 1
    && (objectiveSenderEmails.length === 0
      ? input.expectedSenderEmail === undefined
      : input.expectedSenderEmail === objectiveSenderEmails[0])
    && (requested.scope === 'reply-all'
      ? objectiveEmails.length === 0
      : objectiveEmails.length <= 1
        && (objectiveEmails.length === 0
          || input.expectedRecipientEmail === objectiveEmails[0]))
    && toolName === (requested.scope === 'reply-all'
      ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
      : CONTEXTUAL_GMAIL_REPLY_TOOL);
}

/** True when the accepted objective calls for a reply in an already selected Gmail thread. */
export function isContextualGmailReplyRequestedByObjective(
  objectiveSegments: readonly string[],
): boolean {
  return contextualGmailReplyObjectiveScope(objectiveSegments) !== undefined;
}

/** A contextual Gmail reply mentioned anywhere in the accepted objective must
 * stay on the signed connector path, including when the latest wording asks
 * for a draft, pause, or confirmation rather than authorizing the send. */
export function hasContextualGmailReplyMention(
  objectiveSegments: readonly string[],
): boolean {
  return latestContextualGmailMention(objectiveSegments) !== undefined;
}

/**
 * A new Gmail send cannot safely implement an existing-thread reply: its
 * model-supplied To/CC fields are not proof of the thread's participants.
 */
export function contextualGmailReplyRecoveryReason(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  preflightAttestation?: ContextualGmailReplyPreflightAttestation,
): string | undefined {
  const requested = contextualGmailReplyObjective(objectiveSegments);
  const requestedScope = requested?.scope;
  if (![
    CONTEXTUAL_GMAIL_SEND_TOOL,
    LEGACY_CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_TOOL,
    CONTEXTUAL_GMAIL_REPLY_ALL_TOOL,
  ].includes(toolName)) return undefined;
  if (!requestedScope) {
    const contextualMention = latestContextualGmailMention(objectiveSegments);
    if (!contextualMention) {
      return toolName === CONTEXTUAL_GMAIL_SEND_TOOL
        ? undefined
        : 'Validation failed: Gmail thread replies must use one exact messageId and the signed closed preflight/reply contract. Do not use a legacy or unbound reply path, infer another recipient, or use a browser fallback.';
    }
    const mentionedIds = contextualGmailMessageIds(contextualMention);
    const selectedId = typeof input.messageId === 'string' ? input.messageId.trim().toLowerCase() : '';
    if (mentionedIds.length !== 1
      || toolName !== CONTEXTUAL_GMAIL_SEND_TOOL
        && mentionedIds[0]!.toLowerCase() !== selectedId) {
      return 'Validation failed: the accepted objective does not bind this contextual Gmail reply to one exact messageId. Do not choose another thread or use a browser fallback; obtain one target-bound instruction before sending.';
    }
    return 'Objective authority: a newer accepted instruction restricts or replaces the earlier contextual Gmail reply and does not authorize this exact target now. Continue only with read-only or draft work explicitly requested; do not send or use a browser fallback.';
  }
  const constraints = requested ? contextualGmailResolvedConstraints(requested) : undefined;
  if (!constraints || constraints.invalid) {
    return 'Validation failed: the accepted Gmail objective contains a conflicting or ambiguous exact delimited body or exact fields across its authenticated amendments. Do not infer a target or payload, send, or use a browser fallback; obtain one unambiguous exact instruction.';
  }
  const objectiveMessageIds = constraints.messageIds;
  const objectiveEmails = constraints.recipients;
  const objectiveSenderEmails = constraints.senders;
  const messageId = typeof input.messageId === 'string' ? input.messageId.trim().toLowerCase() : '';
  if (objectiveMessageIds.length > 1) {
    return 'Validation failed: the accepted objective names more than one Gmail messageId. Do not choose a thread or use a browser fallback; obtain one unambiguous target-bound instruction before sending.';
  }
  const exactHumanAnchor = objectiveMessageIds.length === 1
    && objectiveMessageIds[0]!.toLowerCase() === messageId;
  const hostObservedAnchor = objectiveMessageIds.length === 0
    && requested !== undefined
    && contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    );
  const targetBound = toolName === CONTEXTUAL_GMAIL_SEND_TOOL
    ? objectiveMessageIds.length === 1
    : !!messageId && (exactHumanAnchor || hostObservedAnchor);
  if (!targetBound) {
    if (objectiveMessageIds.length === 0) {
      const preflightTool = requestedScope === 'reply-all'
        ? 'mcp__google-contacts__gmail_reply_all_preflight'
        : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
      return `Validation failed: this natural-language thread reply has not yet been host-attested to the selected Gmail message. Use the concrete messageId already returned by the read step with ${preflightTool}, preserving the exact body and recipient scope, then retry only with its signed recipientBinding. Do not ask the user for an internal Gmail id and do not use a browser fallback.`;
    }
    return 'Validation failed: the accepted objective does not bind that authorization to this exact messageId; it binds the contextual Gmail reply to a different messageId. Do not choose another thread or use a browser fallback; obtain one target-bound instruction before sending.';
  }
  if (requestedScope === 'reply-all' && objectiveEmails.length > 0
    || requestedScope === 'reply' && objectiveEmails.length > 1) {
    return 'Validation failed: the accepted contextual Gmail objective contains an ambiguous or incompatible recipient scope. Obtain one target-bound instruction instead of inferring or changing the thread audience.';
  }
  if (objectiveSenderEmails.length > 1) {
    return 'Validation failed: the accepted contextual Gmail objective names more than one sender identity. Obtain one exact From address instead of selecting an account or alias autonomously.';
  }
  if (toolName === (requestedScope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    : CONTEXTUAL_GMAIL_REPLY_TOOL)
    && (objectiveSenderEmails.length === 0
      ? input.expectedSenderEmail !== undefined
      : input.expectedSenderEmail !== objectiveSenderEmails[0])) {
    return 'Validation failed: expectedSenderEmail does not match the exact From identity named in the accepted human objective. Re-run the signed preflight for that authenticated Gmail profile; do not select another account or alias.';
  }
  if (requestedScope === 'reply'
    && toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
    && objectiveEmails.length === 1
    && input.expectedRecipientEmail !== objectiveEmails[0]) {
    return 'Validation failed: expectedRecipientEmail does not match the exact recipient named in the accepted human objective. Re-run the signed preflight for that exact address; do not retarget the reply.';
  }
  const exactBody = constraints.body;
  const suppliedBody = typeof input.body === 'string' ? input.body : '';
  if (exactBody !== undefined && suppliedBody !== exactBody) {
    return 'Validation failed: the Gmail reply body does not match the exact delimited body in the accepted human objective. Reuse that body verbatim in the signed preflight and reply; do not paraphrase it or use a browser fallback.';
  }
  const requiredTool = requestedScope === 'reply-all'
    ? CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    : CONTEXTUAL_GMAIL_REPLY_TOOL;
  if (toolName === requiredTool
    && requested.requiresExactEffectReconciliation
    && !contextualGmailReplyMatchesPreflightAttestation(
      input,
      requested,
      preflightAttestation,
    )) {
    const preflightTool = requestedScope === 'reply-all'
      ? 'mcp__google-contacts__gmail_reply_all_preflight'
      : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
    return `Validation failed: this resumed exact Gmail effect requires one fresh host-observed ${preflightTool} receipt proving a complete, conclusive Sent + Drafts reconciliation with no matching candidate. Run that read-only preflight on the exact anchor and payload, then use only its signed recipientBinding; missing, incomplete, paginated, ambiguous, or candidate-bearing receipts cannot authorize the reply.`;
  }
  if (toolName === requiredTool && isCanonicalContextualGmailReplyInput(toolName, input)) {
    return undefined;
  }
  const preflightTool = requestedScope === 'reply-all'
    ? 'mcp__google-contacts__gmail_reply_all_preflight'
    : CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL;
  const preflightDetail = requestedScope === 'reply-all'
    ? 'whose To/Cc headers match the approved participant set'
    : 'with the exact expected recipient email resolved from that anchor';
  return `Validation failed: the accepted objective requires a contextual ${requestedScope === 'reply-all' ? 'reply-all preserving the thread recipients' : 'recipient-bound reply'} in the existing Gmail thread. Run ${preflightTool} on the exact anchor ${preflightDetail}, then use its recipientBinding with ${requiredTool} and the same closed payload. The legacy mcp__google-contacts__gmail_reply tool is not authorized because it does not bind the recipient. Do not ask for broader permission and do not use a browser fallback.`;
}

/** Open one OSS artifact only when the latest authenticated human boundary is
 * a signed resume contract that repeats both the exact connector and the same
 * literal canonical absolute path. The ordinary broad "write file" MCP
 * classifier deliberately cannot infer this capability. */
interface SignedOssAtomicWriteDecision {
  authorized: boolean;
  sessionId?: string;
}

function signedOssAtomicWriteDecision(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): SignedOssAtomicWriteDecision | undefined {
  if (action.boundedOssAtomicWrite !== true
    || action.commandPreview !== BOUNDED_OSS_ATOMIC_WRITE_TOOL
    || action.category !== 'external_mutation'
    || action.targetCandidates.length !== 1) return undefined;
  const targetPath = boundedOssAtomicWriteLiteralPath(action.targetCandidates[0]);
  if (!targetPath) return undefined;

  const signedResume = /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):[a-f0-9]{6,64}:v[1-9]\d*\][ \t]*$/gmu;
  const signedSource = /^Source OSS exacte autorisée\s*:\s*`([^`\r\n]+)`\.[ \t]*$/gmu;
  const signedSourceLine = /^Source OSS exacte autorisée\s*:/gmu;
  const signedPath = /^Fichier OSS exact autorisé en écriture atomique\s*:\s*`([^`\r\n]+)`\.[ \t]*$/gmu;
  const signedPathLine = /^Fichier OSS exact autorisé en écriture atomique\s*:/gmu;
  const localWriteRevocation = /\b(?:(?:ne|n)\s+(?:ecris|ecrivez|ecrire|modifie|modifiez|modifier|remplace|remplacez|remplacer)[^.!?;\n]{0,80}\b(?:pas|plus|jamais)\b|(?:do not|don t|never)\s+(?:write|modify|replace)\b|(?:ecriture|modification|remplacement|write|writing|modification|replacement)\b[^.!?;\n]{0,50}\b(?:interdit|interdite|forbidden|not allowed))\b/u;
  const sourceRetarget = /\b(?:(?:utilise|utilisez|use)\s+(?:(?:desormais|maintenant|finalement|now|instead)\s+)?(?:une\s+autre|another|other)\s+(?:source|connecteur|connector)|(?:source|connecteur|connector)\s+(?:devient|becomes)\b|(?:plutot|rather|instead)\b[^.!?;\n]{0,60}\b(?:source|connecteur|connector)\b)/u;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest || isTargetFreeGenericContinuation(normalizedRequest)
      || isClosedTargetFreeProgressFollowUp(rawRequest, normalizedRequest)) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return { authorized: false };
    const resumeMatches = [...rawRequest.matchAll(signedResume)];
    const sourceMatches = [...rawRequest.matchAll(signedSource)];
    const pathMatches = [...rawRequest.matchAll(signedPath)];
    const contractPath = boundedOssAtomicWriteLiteralPath(pathMatches[0]?.[1]);
    const firstNonWhitespace = rawRequest.search(/\S/u);
    const otherLiteralPaths = [...rawRequest.matchAll(/`([^`\r\n]+)`/gu)]
      .map(match => match[1] ?? '')
      .filter(value => value !== targetPath
        && (value.includes('/') || hasDynamicOrGlobTargetSyntax(value)));
    if (isNonAuthorizingRequest(rawRequest, normalizedRequest)
      || /```|~~~|^\s*>/mu.test(rawRequest)
      || resumeMatches.length !== 1
      || resumeMatches[0]?.index !== firstNonWhitespace
      || (rawRequest.match(/\[robb-resume:/gu)?.length ?? 0) !== 1
      || sourceMatches.length !== 1 || sourceMatches[0]?.[1] !== 'rbw-agents-oss'
      || [...rawRequest.matchAll(signedSourceLine)].length !== 1
      || pathMatches.length !== 1 || contractPath !== targetPath
      || [...rawRequest.matchAll(signedPathLine)].length !== 1
      || otherLiteralPaths.length > 0
      || localWriteRevocation.test(normalizedRequest)
      || sourceRetarget.test(normalizedRequest)) return { authorized: false };
    const clauses = requestClauses(rawRequest);
    const authorized = !clauses.some(clause => targetIsNamed(clause, targetPath)
      && targetIsNegatedInClause(clause, targetPath));
    return {
      authorized,
      ...(authorized ? { sessionId: resumeMatches[0]?.[1] } : {}),
    };
  }
  return { authorized: false };
}

/** Return the session bound by the same exact contract that authorizes this
 * OSS write. PreToolUse compares it with its host-owned active session ID. */
export function signedOssAtomicWriteAuthorizedSessionId(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): string | undefined {
  const decision = signedOssAtomicWriteDecision(
    action,
    externalActionAuthorityPolicySegments(objectiveSegments),
  );
  return decision?.authorized ? decision.sessionId : undefined;
}

const BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /\b(?:cible exacte autorisee|exact target authorized|exact authorized target)\b|\b(?:cible exacte|exact target)\s*:/u;
const AFFIRMATIVE_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /^(?:(?:cible exacte autorisee|exact target authorized|exact authorized target)\b|(?:cible exacte|exact target)\s*:)/u;
const COLON_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION = /(?:^|[.!?;\n][ \t]*)(?:cible\s+exacte|exact\s+target)\s*:\s*([^.!?;\n]{1,1000})/giu;
const NEGATIVE_EXACT_SCOPE_VALUE = /\b(?:aucun|aucune|none|nothing|no|not|never|pas|sans|without)\b/u;
const READ_ONLY_EXACT_SCOPE_QUALIFIER = /\b(?:lecture seule|read only|observation only|sans (?:aucune )?(?:modification|ecriture|mutation)|without (?:any )?(?:change|write|mutation))\b/u;
const EXPLICIT_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION = /\b(?:deja\s+autorise(?:e|es|s)?|already\s+authorized)\b/u;
const NEGATED_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION = /\b(?:pas|non|jamais|not|never)\b[^.!?;\n]{0,40}\b(?:autorise(?:e|es|s)?|authorized)\b/u;

function hasAffirmativeBoundedRemoteExactScopeDeclaration(rawRequest: string): boolean {
  // `requestClauses` deliberately treats `:` as an instruction boundary. Read
  // this common labelled form directly so “Cible exacte : serveur dev, …”
  // keeps its value attached to the declaration instead of becoming an empty
  // heading. All negative/read-only qualifiers remain fail-closed below.
  for (const match of rawRequest.matchAll(COLON_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION)) {
    const declaredScope = normalizeForMatch(match[1] ?? '').trim();
    if (declaredScope.length > 0
      && !NEGATIVE_EXACT_SCOPE_VALUE.test(declaredScope)
      && !READ_ONLY_EXACT_SCOPE_QUALIFIER.test(declaredScope)) return true;
  }
  return requestClauses(rawRequest).some((rawClause) => {
    const clause = normalizeForMatch(rawClause);
    const declaration = AFFIRMATIVE_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION.exec(clause);
    if (!declaration) return false;
    const declaredScope = clause.slice(declaration[0].length).trim();
    return declaredScope.length > 0
      && !NEGATIVE_EXACT_SCOPE_VALUE.test(declaredScope)
      && !READ_ONLY_EXACT_SCOPE_QUALIFIER.test(declaredScope);
  });
}

function boundedRemoteCommandHostPromptRequested(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean | undefined {
  if (!action.remoteCommand) return undefined;
  // Connector and tool identity are part of this compatibility boundary.
  // A similarly named executor from another MCP source must not inherit the
  // rbw-servers confirmation path from matching command/cwd text alone.
  if (!action.boundedRemoteHostPrompt) return false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return false;
    const namesAction = requestNamesSensitiveAction(action, normalizedRequest);
    const declaresExactScope = hasAffirmativeBoundedRemoteExactScopeDeclaration(rawRequest);
    if (!namesAction && !declaresExactScope) {
      if (isTargetFreeGenericContinuation(normalizedRequest)) continue;
      // Newest meaningful human scope owns this narrow compatibility path.
      // An analysis, retarget, pause or unclassified amendment cannot be
      // skipped to resurrect an older remote authorization.
      return false;
    }
    if (!namesAction || !declaresExactScope
      || isNonAuthorizingRequest(rawRequest, normalizedRequest)) return false;
    const clauses = requestClauses(rawRequest);
    return action.targetCandidates.every(target => (
      targetIsNamed(rawRequest, target)
      && !clauses.some(clause => targetIsNamed(clause, target)
        && targetIsNegatedInClause(clause, target))
    ));
  }
  return false;
}

/** A bounded remote objective that merely names an exact scope still reaches
 * the host confirmation UI. It becomes direct execution authority only when
 * the same newest authenticated segment also says that scope is already
 * authorized. The ordinary action, target, negation and retarget checks above
 * still apply in full. */
function boundedRemoteCommandDirectExecutionAuthorized(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean {
  if (!action.remoteCommand || !action.boundedRemoteHostPrompt) return false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (isTargetFreeGenericContinuation(normalizedRequest)) continue;
    // The authorization must qualify the mutation itself, not merely another
    // capability mentioned somewhere in the same long objective. In
    // particular, “read-only SSH access is already authorized; start the
    // service” must still reach the scoped confirmation boundary. The live
    // Orion contract keeps the start/restart verb and “périmètre déjà
    // autorisé” in one clause, so it remains directly executable.
    const actionBoundAuthorization = requestClauses(rawRequest).some(rawClause => {
      const clause = normalizeForMatch(rawClause);
      const authorization = EXPLICIT_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION.exec(clause);
      if (!authorization || NEGATED_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION.test(clause)
        || READ_ONLY_EXACT_SCOPE_QUALIFIER.test(clause)) return false;
      const before = clause.slice(0, authorization.index).trim();
      const after = clause.slice(authorization.index + authorization[0].length).trim();
      const actionScope = /\b(?:mission|perimetre|scope|action|operation|mutation|demarrage|redemarrage|start|restart|deploiement|deployment|correction|intervention)\b/u;
      const unrelatedReadCapability = /\b(?:acces|access|connexion|ssh|logs?|consultation|lecture|read|audit|inspection|observation)\b/u;
      const authorizationQualifiesPriorAction = requestNamesSensitiveAction(action, before)
        && actionScope.test(before)
        && !unrelatedReadCapability.test(before);
      const authorizationDirectlyIntroducesAction = /^(?:a|to)\b/u.test(after)
        && requestNamesSensitiveAction(action, after)
        && !unrelatedReadCapability.test(after);
      return authorizationQualifiesPriorAction || authorizationDirectlyIntroducesAction;
    });
    if (!actionBoundAuthorization) return false;
    return boundedRemoteCommandHostPromptRequested(action, [rawRequest]) === true;
  }
  return false;
}

function confirmationAliasIsBoundInSegment(
  action: SensitiveExternalAction,
  rawRequest: string,
  alias: string,
): boolean {
  if (action.targetCandidates.length !== 1
    || !targetIsNamed(rawRequest, action.targetCandidates[0]!)) return false;
  const affirmativeAliases = new Set<string>();
  for (const clause of requestClauses(rawRequest)) {
    const normalizedClause = normalizeForMatch(clause);
    const bindings = normalizedClause.matchAll(
      /\b(?:ecris|ecrire|envoie|envoyer|send|write)\b[^.!?;\n]{0,100}?\b(?:a|to|vers)\s+([a-z0-9][a-z0-9-]*)\b/gu,
    );
    for (const binding of bindings) {
      const candidate = binding[1];
      if (!candidate) continue;
      const aliasOffset = binding[0].lastIndexOf(candidate);
      const aliasIndex = (binding.index ?? 0) + aliasOffset;
      const beforeAlias = normalizedClause.slice(0, aliasIndex);
      const negated = /\b(?:do not|don t|never|not)\b/u.test(beforeAlias)
        || /\b(?:ne|n)\b[^.!?;\n]{0,80}\b(?:jamais|pas|plus)\b/u.test(beforeAlias)
        || /\b(?:jamais|never|pas|sans|without)\b[^.!?;\n]{0,40}\b(?:a|to|vers)\s*$/u.test(beforeAlias);
      if (!negated) affirmativeAliases.add(candidate);
    }
  }
  // An alias can resume a target-bound confirmation only when the root names
  // exactly one affirmative human alias. Multiple recipients in the same
  // segment are ambiguous without an explicit alias-to-address relation.
  return affirmativeAliases.size === 1 && affirmativeAliases.has(alias);
}

/**
 * Detect a host-confirmation boundary that the human explicitly requested for
 * this exact action and target. This is not execution authority: it only lets
 * the attempted tool reach the host's scoped permission prompt. A generic
 * question answer, model prose, tool output, retarget, or prohibition cannot
 * satisfy this predicate.
 */
export function isSensitiveExternalActionConfirmationRequestedByObjective(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(objectiveSegments);
  if (action.targetCandidates.length === 0
    || action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;

  if (boundedRemoteCommandDirectExecutionAuthorized(action, policySegments)) return false;
  const boundedRemotePrompt = boundedRemoteCommandHostPromptRequested(
    action,
    policySegments,
  );
  if (boundedRemotePrompt !== undefined) return boundedRemotePrompt;

  let resumedBoundaryAlias: string | undefined;
  for (let index = policySegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = policySegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return false;

    const namesCategory = requestNamesSensitiveActionCategory(action, normalizedRequest);
    const retargets = requestExplicitlyRetargets(action, rawRequest, normalizedRequest);
    const continuation = externalConfirmationContinuationAlias(normalizedRequest);
    if (!namesCategory && !retargets && !continuation) continue;
    if (retargets) return false;
    if (isNonAuthorizingRequest(rawRequest, normalizedRequest)) return false;

    const clauses = requestClauses(rawRequest);
    const everyTargetNamed = action.targetCandidates.every(target => (
      targetIsNamed(rawRequest, target)
      && !clauses.some(clause => targetIsNamed(clause, target)
        && targetIsNegatedInClause(clause, target))
    ));
    if (!everyTargetNamed || !requestMatchesConditionalTargets(action, rawRequest)) {
      if (!continuation || action.targetCandidates.length !== 1) return false;
      resumedBoundaryAlias = continuation.alias;
      continue;
    }

    const hasBoundary = EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION.test(normalizedRequest)
      || EXPLICIT_ACTION_AFTER_CONFIRMATION.test(normalizedRequest);
    if (!hasBoundary) return false;
    return resumedBoundaryAlias === undefined
      || confirmationAliasIsBoundInSegment(action, rawRequest, resumedBoundaryAlias);
  }
  return false;
}

/**
 * Resolve a sensitive action against authenticated objective segments without
 * joining unrelated text. The newest segment that names this action category
 * owns its target: a retarget, question, analysis request, or negation cannot
 * fall through to an older authorization, while a generic "continue" can.
 */
export function isSensitiveExternalActionAuthorizedByObjective(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
  authenticatedUserAuthorizationSegments: readonly string[] = [],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(objectiveSegments);
  const markerCount = (segments: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const segment of segments) {
      if (!segment.startsWith(`${HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER}\n`)) continue;
      counts.set(segment, (counts.get(segment) ?? 0) + 1);
    }
    return counts;
  };
  const policyMarkerCounts = markerCount(policySegments);
  const authenticatedMarkerCounts = markerCount(authenticatedUserAuthorizationSegments);
  const remainingAuthenticatedMarkers = new Map(authenticatedMarkerCounts);
  if (action.commandPreview === BOUNDED_OSS_ATOMIC_WRITE_TOOL
    && action.boundedOssAtomicWrite !== true) return false;
  const exactOssAtomicWrite = signedOssAtomicWriteDecision(
    action,
    policySegments,
  );
  if (exactOssAtomicWrite !== undefined) return exactOssAtomicWrite.authorized;
  if (boundedRemoteCommandDirectExecutionAuthorized(action, policySegments)) return true;
  if (action.remoteCommand) {
    const newestExactScopeSegment = [...policySegments].reverse().find(segment => (
      BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION.test(normalizeForMatch(segment))
    ));
    // An explicit exact-scope contract belongs only to the audited remote
    // connector, and a negative/read-only declaration cannot become generic
    // Execute authority merely because it still names the same project.
    if (newestExactScopeSegment && (
      !action.boundedRemoteHostPrompt
      || !hasAffirmativeBoundedRemoteExactScopeDeclaration(newestExactScopeSegment)
    )) return false;
  }
  for (let index = policySegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = policySegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    // A structured question answer is accepted by the host only after the
    // user selected one affirmative option. For the audited rbw-servers
    // executor, that selection is the scoped confirmation boundary: the
    // displayed question must still name the mutation and every concrete
    // target. Generic answers remain closed to resolved non-remote actions.
    if (rawRequest.startsWith(`${HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER}\n`)) {
      const policyCount = policyMarkerCounts.get(rawRequest) ?? 0;
      const authenticatedCount = authenticatedMarkerCounts.get(rawRequest) ?? 0;
      const remaining = remainingAuthenticatedMarkers.get(rawRequest) ?? 0;
      // String equality alone is not provenance: a public amendment can copy
      // a real hidden marker. Require an exact occurrence-for-occurrence
      // correspondence and consume this host capability once for this scan.
      const authenticated = parseHostAuthenticatedUserAuthorization(rawRequest);
      if (policyCount !== authenticatedCount || remaining <= 0
        || !authenticated
        || hostAuthenticatedAuthorizationContainsNoEffectDirective(authenticated, action)) return false;
      remainingAuthenticatedMarkers.set(rawRequest, remaining - 1);
      if (genericHostAuthenticatedUserAuthorization(action, rawRequest)) return true;
      // Distinct authenticated answers may authorize independent categories.
      // Only an answer that names or retargets this action owns its boundary;
      // unrelated host answers do not erase older still-valid authority.
      if (requestNamesSensitiveActionCategory(action, normalizedRequest)
        || requestExplicitlyRetargets(action, rawRequest, normalizedRequest)) return false;
      continue;
    }
    if (isSensitiveExternalActionExplicitlyAuthorized(action, rawRequest)) return true;
    if (requestNamesSensitiveActionCategory(action, normalizedRequest)) return false;
    if (requestExplicitlyRetargets(action, rawRequest, normalizedRequest)) return false;
  }
  return false;
}
