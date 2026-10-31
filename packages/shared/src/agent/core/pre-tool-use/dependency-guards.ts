import { isUnknownArray } from '../../../utils/json.ts';
import { REQUEST_USER_INPUT_TOOL_NAMES } from './autonomy-request-guards.ts';
import { contextualGmailToolReceipt } from './gmail-evidence.ts';
import { normalizeAutonomyGuardText } from './tool-names.ts';

export type PendingDependencyKind = 'access' | 'credential' | 'endpoint' | 'key' | 'response' | 'token';

export interface PendingThirdPartyDependency {
  kinds: Set<PendingDependencyKind>;
  party: string;
}

const NON_PARTY_NAME_TOKENS = new Set([
  'API', 'CRM', 'CSV', 'DNS', 'ERP', 'HTTP', 'HTTPS', 'JSON', 'MFA', 'MCP',
  'PDF', 'REST', 'SQL', 'SSH', 'SSO', 'UI', 'URL', 'UX', 'VPS',
  'CLIENT', 'IMPORTANT', 'URGENT', 'THE', 'LE', 'LA', 'UN', 'UNE',
  'FOURNISSEUR', 'PROVIDER', 'VENDOR', 'PRESTATAIRE', 'EDITEUR',
]);

const THIRD_PARTY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['isagri', 'agiris'],
  ['guardtek', 'guartech'],
];

function canonicalThirdPartyName(value: string): string {
  const normalized = normalizeAutonomyGuardText(value).replace(/[^a-z0-9&._-]/gu, '');
  const aliases = THIRD_PARTY_ALIAS_GROUPS.find(group => group.includes(normalized));
  return aliases?.[0] ?? normalized;
}

function extractThirdPartyNames(rawText: string): Set<string> {
  const parties = new Set<string>();
  const normalized = normalizeAutonomyGuardText(rawText);
  for (const aliases of THIRD_PARTY_ALIAS_GROUPS) {
    if (aliases.some(alias => new RegExp(`\\b${alias}\\b`, 'u').test(normalized))) {
      parties.add(aliases[0]!);
    }
  }
  // Unknown names are accepted only when grammar binds them to a third-party
  // role or to the dependency item itself. Treating every ALL-CAPS token as a
  // supplier made labels such as URGENT/IMPORTANT/CLIENT into false blockers.
  const contextualNamePatterns = [
    /\b(?:fournisseur|vendor|provider|prestataire|editeur|éditeur)\s+([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:from|de\s+la\s+part\s+(?:de|d['’]))\s*(?:(?:le|la|l['’]|the)\s+)?([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:chez|from|par|de la part de|fournisseur|vendor|provider|prestataire|editeur|éditeur)\s+(?:(?:le|la|l['’]|the)\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
    /\bwaiting\s+on\s+([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:access|accès|acces|credential|credentials|identifiant|identifiants|endpoint|url|key|clé|cle|token)\s+(?:(?:API|api)\s+)?(?:de\s+|du\s+|d['’]\s*|from\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
    /\b([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\s+(?:API\s+)?(?:access|credential|credentials|endpoint|key|token|url)\b/gu,
    /\b([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\s+(?:doit(?:\s+encore)?|must|has\s+yet\s+to|is\s+still\s+outstanding)\b/gu,
    /\b(?:de|du|d['’]|from)\s+(?:(?:le|la|l['’]|the)\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
  ];
  for (const pattern of contextualNamePatterns) {
    for (const match of rawText.matchAll(pattern)) {
      const value = match[1]!;
      if (!NON_PARTY_NAME_TOKENS.has(value.toUpperCase())) {
        parties.add(canonicalThirdPartyName(value));
      }
    }
  }
  parties.delete('');
  return parties;
}

function extractPendingDependencyKinds(text: string): Set<PendingDependencyKind> {
  const kinds = new Set<PendingDependencyKind>();
  if (/\b(?:access|acces|grant|autorisation|authorization|ouverture)\b/u.test(text)) kinds.add('access');
  if (/\b(?:credential|credentials|identifiant|identifiants|secret)\b/u.test(text)) kinds.add('credential');
  if (/\b(?:endpoint|url)\b/u.test(text)) kinds.add('endpoint');
  if (/\b(?:key|cle)\b/u.test(text)) kinds.add('key');
  if (/\b(?:vendor response|reponse|response|retour)\b/u.test(text)) kinds.add('response');
  if (/\btoken\b/u.test(text)) kinds.add('token');
  return kinds;
}

function objectiveEstablishesThirdPartyDependency(
  segments: readonly string[],
): PendingThirdPartyDependency[] {
  const byParty = new Map<string, Set<PendingDependencyKind>>();
  let contextualParties = new Set<string>();
  const pendingPattern = /\b(?:await(?:ing)?|waiting|pending|attend(?:s|ons|ez|re)?|en attente|patient(?:e|er|ons|ez)?|n['’]?\s*a\s+pas\s+encore\s+(?:fourni|envoye)|doit(?:\s+encore)?(?:\s+nous)?\s+(?:fournir|envoyer|parvenir)|must(?:\s+still)?\s+(?:provide|send)|reste a (?:recevoir|obtenir)|(?:est|sont)\s+attendu(?:e|es|s)?|il\s+manque|has\s+yet\s+to\s+(?:provide|send)|(?:is|are)\s+still\s+outstanding)\b/u;
  const explicitlyNotPendingPattern = /\b(?:no longer (?:waiting|pending|awaiting)|not (?:waiting|pending|awaiting)|n['’]?attend[^.!?;\n]{0,50}(?:plus|pas)|ne sommes (?:plus |pas )?en attente|n['’]?est (?:plus |pas )?en attente|ne (?:suis|sommes|sont) pas en attente|(?:nous\s+)?ne\s+devons\s+pas\s+attendre|sans\s+attendre|without\s+waiting)\b/u;
  const unresolvedReceiptPattern = /\b(?:(?:not|has\s+not|have\s+not|n|ne|non|pas|sans)\b[^.!?;\n]{0,50}\b(?:received|obtained|arrived|provided|supplied|available|ready|recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes)|pas\s+encore\s+(?:recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes))\b/u;
  const affirmativelyResolvedPattern = /\b(?:received|obtained|arrived|provided|supplied|available|ready|recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes)\b/u;

  for (const segment of segments) {
    for (const rawClause of segment.split(/[.!?;\n]+/u)) {
      if (!rawClause.trim()) continue;
      const normalizedClause = normalizeAutonomyGuardText(rawClause);
      // A future condition is neither evidence that a dependency exists nor
      // evidence that it has resolved. Keep prior observed/pending state intact.
      if (/^(?:si|if)\b/u.test(normalizedClause)) continue;
      const clauseParties = extractThirdPartyNames(rawClause);
      if (clauseParties.size > 0) contextualParties = clauseParties;
      const kinds = extractPendingDependencyKinds(normalizedClause);
      if (kinds.size === 0) continue;
      const parties = clauseParties.size > 0
        ? clauseParties
        : contextualParties.size === 1 ? contextualParties : new Set<string>();
      if (parties.size === 0) continue;

      const explicitlyNotPending = explicitlyNotPendingPattern.test(normalizedClause);
      const unresolvedReceipt = unresolvedReceiptPattern.test(normalizedClause);
      const pending = unresolvedReceipt || pendingPattern.test(normalizedClause);
      // Pending wins over a contradictory positive receipt word. The only
      // higher-precedence resolution is an explicit statement that the item is
      // not/no-longer pending (for example "nous n'attendons plus").
      const resolved = explicitlyNotPending
        || !pending && affirmativelyResolvedPattern.test(normalizedClause);
      if (resolved) {
        for (const party of parties) {
          const existing = byParty.get(party);
          for (const kind of kinds) existing?.delete(kind);
          if (existing?.size === 0) byParty.delete(party);
        }
      } else if (pending) {
        for (const party of parties) {
          const existing = byParty.get(party) ?? new Set<PendingDependencyKind>();
          for (const kind of kinds) existing.add(kind);
          byParty.set(party, existing);
        }
      }
    }
  }

  return [...byParty].map(([party, kinds]) => ({ party, kinds }));
}

function isTrustedThirdPartyDependencyReceiptTool(toolName: string): boolean {
  return /^mcp__[^_]+__(?:connection|dependency|access|credential|provider|vendor)_status$/iu.test(toolName);
}

export function hostObservedThirdPartyDependencies(
  toolName: string,
  result: string,
): PendingThirdPartyDependency[] {
  if (!result || result.length > 100_000) return [];
  if (!isTrustedThirdPartyDependencyReceiptTool(toolName)) return [];
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return [];
  const pending = receipt["pending"] === true
    || ['pending', 'awaiting_external', 'waiting_on_vendor', 'waiting_on_provider']
      .includes(String(receipt["status"] ?? receipt["state"] ?? '').toLowerCase());
  if (!pending) return [];
  const rawParty = [receipt["party"], receipt["provider"], receipt["vendor"], receipt["externalParty"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 1);
  if (!rawParty) return [];
  const party = canonicalThirdPartyName(rawParty);
  if (!party || NON_PARTY_NAME_TOKENS.has(rawParty.trim().toUpperCase())) return [];
  const dependencyText = [
    receipt["kind"],
    receipt["dependencyKind"],
    receipt["item"],
    receipt["message"],
  ].filter((value): value is string => typeof value === 'string').join(' ');
  const kinds = extractPendingDependencyKinds(
    normalizeAutonomyGuardText(dependencyText).replace(/[_-]+/gu, ' '),
  );
  return kinds.size > 0 ? [{ party, kinds }] : [];
}

export function hostObservedResolvedThirdPartyDependencies(
  toolName: string,
  result: string,
): PendingThirdPartyDependency[] {
  if (!result || result.length > 100_000) return [];
  if (!isTrustedThirdPartyDependencyReceiptTool(toolName)) return [];
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return [];
  const resolved = receipt["pending"] === false
    || ['received', 'resolved', 'ready', 'complete', 'completed', 'available']
      .includes(String(receipt["status"] ?? receipt["state"] ?? '').toLowerCase());
  if (!resolved) return [];
  const rawParty = [receipt["party"], receipt["provider"], receipt["vendor"], receipt["externalParty"]]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 1);
  if (!rawParty || NON_PARTY_NAME_TOKENS.has(rawParty.trim().toUpperCase())) return [];
  const dependencyText = [
    receipt["kind"],
    receipt["dependencyKind"],
    receipt["item"],
    receipt["message"],
  ].filter((value): value is string => typeof value === 'string').join(' ');
  const kinds = extractPendingDependencyKinds(
    normalizeAutonomyGuardText(dependencyText).replace(/[_-]+/gu, ' '),
  );
  return kinds.size > 0
    ? [{ party: canonicalThirdPartyName(rawParty), kinds }]
    : [];
}

function questionAndDecisionTexts(input: Record<string, unknown>): Array<{
  question: string;
  decisions: string;
}> {
  const questions = isUnknownArray(input["questions"]) ? input["questions"] : [];
  const result: Array<{ question: string; decisions: string }> = [];
  for (const rawQuestion of questions) {
    if (!rawQuestion || typeof rawQuestion !== 'object') continue;
    const question = rawQuestion as Record<string, unknown>;
    const decisions: string[] = [];
    for (const rawOption of isUnknownArray(question["options"]) ? question["options"] : []) {
      if (!rawOption || typeof rawOption !== 'object') continue;
      const option = rawOption as Record<string, unknown>;
      if (typeof option["label"] === 'string') decisions.push(option["label"]);
      if (typeof option["description"] === 'string') decisions.push(option["description"]);
    }
    result.push({
      question: typeof question["question"] === 'string' ? question["question"] : '',
      decisions: decisions.join(' '),
    });
  }
  return result;
}

export function redundantlyAsksAboutEstablishedThirdPartyDependency(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  observedDependencies: readonly PendingThirdPartyDependency[] = [],
  observedResolvedDependencies: readonly PendingThirdPartyDependency[] = [],
): boolean {
  if (!REQUEST_USER_INPUT_TOOL_NAMES.has(toolName)) return false;
  let explicitlyRequestedQuestion = false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    const normalized = normalizeAutonomyGuardText(segment);
    const revokesRepeatedQuestion = /\b(?:ne\s+(?:me\s+)?(?:re)?demande\s+plus|arrete\s+de\s+(?:me\s+)?(?:re)?demander|n(?:['’]\s*|\s+)utilise\s+plus\s+(?:le\s+)?request_user_input|do\s+not\s+ask(?:\s+me)?\s+again|don['’]?t\s+ask(?:\s+me)?\s+again|never\s+ask(?:\s+me)?\s+again|stop\s+asking(?:\s+me)?|do\s+not\s+use\s+request_user_input\s+again)\b/u.test(normalized);
    if (revokesRepeatedQuestion) break;
    const explicitlyRequestsQuestion = /\b(?:utilise|use)\s+(?:le\s+)?request_user_input\b/u.test(normalized)
      && /\b(?:demande(?:r)?|ask)\b[^.!?;\n]{0,100}\b(?:faut il|should|wait|attendre)\b/u.test(normalized);
    if (explicitlyRequestsQuestion) {
      explicitlyRequestedQuestion = true;
      break;
    }
  }
  if (explicitlyRequestedQuestion) return false;
  const dependenciesByParty = new Map<string, Set<PendingDependencyKind>>();
  for (const dependency of [
    ...objectiveEstablishesThirdPartyDependency(objectiveSegments),
  ]) {
    const kinds = dependenciesByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
    for (const kind of dependency.kinds) kinds.add(kind);
    dependenciesByParty.set(dependency.party, kinds);
  }
  for (const resolved of observedResolvedDependencies) {
    const kinds = dependenciesByParty.get(resolved.party);
    for (const kind of resolved.kinds) kinds?.delete(kind);
    if (kinds?.size === 0) dependenciesByParty.delete(resolved.party);
  }
  for (const dependency of observedDependencies) {
    const kinds = dependenciesByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
    for (const kind of dependency.kinds) kinds.add(kind);
    dependenciesByParty.set(dependency.party, kinds);
  }
  const dependencies = [...dependenciesByParty]
    .map(([party, kinds]) => ({ party, kinds }));
  if (dependencies.length === 0) return false;
  const dependencyChoice = /\b(?:wait|waiting|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|pause|defer|differer|reporter|postpone|later|plus tard|fournir|provide|enter|saisir|relance|relancer|contacter|contact|follow up|remind|rappeler)\b/u;
  const waitChoice = /\b(?:wait|waiting|attente|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|pause|defer|differer|reporter|postpone|later|plus tard)\b/u;
  const questionAsksDependencyChoice = /(?:\b(?:faut[- ]il|doit[- ]on|devons[- ]nous|souhaitez[- ]vous(?:\s+que\s+je)?|voulez[- ]vous(?:\s+que\s+je)?|should we|shall i|do you want me to|would you like (?:me|us) to|would you like to|what should (?:we|i))\b[^?]{0,120}|^\s*)\b(?:wait|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|defer|differer|reporter|postpone|fournir|provide|relancer|contacter|follow up)\b/u;
  const genericPendingChoiceQuestion = /\b(?:quelle\s+suite|que\s+faire|what\s+next|next\s+step)\b[^?]{0,80}\b(?:attente|waiting|pending)\b/u;
  const sameGenericThirdParty = /\b(?:ce|cet|cette|le|la|notre|the|our|same|meme)\s+(?:third party|tiers|vendor|fournisseur|provider|prestataire|editeur)\b/u;
  const anaphoricDependencyOwner = /\b(?:leur|leurs|sa|son|ses|cette|ce|cet|their|its|this|that)\s+(?:access|acces|credential|credentials|endpoint|key|cle|token|reponse|response|retour)\b/u;
  const explicitlyNamesAnotherWaitTarget = /\b(?:(?:wait|waiting|hold\s+off|sit\s+tight|postpone|defer)\b[^?;\n]{0,70}\b(?:tests?|test\s+suite|build|server|database|migration|deployment|job|command|process)|(?:attendre|patienter|reporter|suspendre|rest(?:e|er)\s+en\s+attente|n(?:['’]\s*|\s+)avance(?:r)?\s+pas)\b[^?;\n]{0,70}\b(?:tests?|suite\s+de\s+tests?|build|compilation|serveur|base\s+de\s+donnees|migration|deploiement|commande|processus))\b/u;
  // Waiting for an already-established dependency is not a user decision, but
  // replacing the blocked provider/integration is. Preserve that substantive
  // business fork instead of trapping the mission in the current wait state.
  const substantiveAlternativeChoice = /\b(?:(?:use|choose|adopt|select|switch\s+to|move\s+to|replace\s+(?:it|them)?\s*(?:with|by)|utiliser|choisir|adopter|selectionner|basculer\s+(?:vers|sur)|remplacer(?:\s+(?:le|la|les|lui|leur))?\s+par)\b[^?;\n]{0,70}\b(?:another|other|alternative|different|backup|autre|alternative?)\b[^?;\n]{0,40}\b(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur)|(?:change|switch|replace|changer|remplacer)\b[^?;\n]{0,40}\b(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur)|(?:another|other|alternative|different|backup|autre|alternative?)\s+(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur))\b/u;

  return questionAndDecisionTexts(input).some(({ question, decisions }) => {
    const normalizedQuestion = normalizeAutonomyGuardText(question);
    const normalizedDecisions = normalizeAutonomyGuardText(decisions);
    if (!dependencyChoice.test(normalizedDecisions)
      && !questionAsksDependencyChoice.test(normalizedQuestion)
      && !genericPendingChoiceQuestion.test(normalizedQuestion)) return false;
    const rawCombined = `${question}\n${decisions}`;
    const combined = normalizeAutonomyGuardText(rawCombined);
    if (substantiveAlternativeChoice.test(combined)) return false;
    const questionParties = extractThirdPartyNames(rawCombined);
    const questionKinds = extractPendingDependencyKinds(combined);
    const waits = waitChoice.test(`${normalizedQuestion} ${normalizedDecisions}`);
    return dependencies.some((dependency) => {
      const sameParty = questionParties.size > 0
        ? questionParties.has(dependency.party)
        : dependencies.length === 1 && (
          sameGenericThirdParty.test(combined)
          || anaphoricDependencyOwner.test(combined)
          || waits && !explicitlyNamesAnotherWaitTarget.test(combined)
        );
      if (!sameParty) return false;
      const sameKind = [...questionKinds].some(kind => dependency.kinds.has(kind));
      return sameKind || waits && questionKinds.size === 0;
    });
  });
}
