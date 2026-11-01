import { parseStructuredGmailSendResumeSegment } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction, SensitiveExternalActionCategory } from './types.ts';

export const ACTION_DETAILS: Record<SensitiveExternalActionCategory, {
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

export const TARGET_FIELD_NAMES = new Set([
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

export const UNRESOLVED_REMOTE_SCOPE = 'unresolved remote scope';

export const UNRESOLVED_EXTERNAL_TARGET = 'unresolved external target';

export const UNRESOLVED_EXTERNAL_AUDIENCE = 'unresolved external audience';

export const ADDITIONAL_UNRESOLVED_TARGETS = 'additional unresolved targets';

export const UNRESOLVED_TARGET_SENTINELS = new Set([
  UNRESOLVED_REMOTE_SCOPE,
  UNRESOLVED_EXTERNAL_TARGET,
  UNRESOLVED_EXTERNAL_AUDIENCE,
  ADDITIONAL_UNRESOLVED_TARGETS,
]);

export const HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER = '[host-authenticated-user-authorization:v1]';

export function parseHostAuthenticatedUserAuthorization(rawRequest: string): {
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

export function hostAuthenticatedAuthorizationContainsNoEffectDirective(
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
export function structuredGmailPolicyRequest(rawRequest: string): string {
  if (!parseStructuredGmailSendResumeSegment(rawRequest)) return rawRequest;
  const start = rawRequest.indexOf('BODY_BEGIN\n') + 'BODY_BEGIN\n'.length;
  const end = rawRequest.indexOf('\nBODY_END', start);
  return `${rawRequest.slice(0, start)}[exact Gmail payload body omitted from generic action authority]${rawRequest.slice(end)}`;
}

export function externalActionAuthorityPolicySegments(segments: readonly string[]): string[] {
  return segments.map(structuredGmailPolicyRequest);
}

export function hasDynamicOrGlobTargetSyntax(value: string): boolean {
  return /[$`*?[\]{}~]/u.test(value) || /[\0\r\n]/u.test(value);
}
