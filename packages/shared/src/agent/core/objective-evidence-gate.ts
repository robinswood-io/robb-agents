import {
  DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE,
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE,
} from './rbac-action-grammar.ts';

export type HighStakesEvidenceDomain = 'legal' | 'financial' | 'medical' | 'security' | 'unspecified';
type SecurityDocumentationProvider = 'docker' | 'github' | 'microsoft' | 'openai' | 'systemd';

export interface ObjectiveEvidenceGateState {
  objectiveId: string;
  domain: HighStakesEvidenceDomain;
  evidenceObserved: boolean;
  authoritativeEvidenceObserved: boolean;
  independentReviewObserved: boolean;
  independentReviewAttempted: boolean;
  lastReviewVerdict?: 'PASS' | 'FAIL';
  /** A later mutation makes any earlier review stale until it is repeated. */
  reviewInvalidatedByMutation?: boolean;
  lastMutationTool?: string;
  /** Narrow vendor bindings derived from the accepted objective text. */
  businessSourceVendors?: Array<'cerfrance' | 'silae'>;
  /** Provider documentation is authoritative only when the accepted objective
   * actually concerns that provider or runtime. */
  securityDocumentationProviders?: SecurityDocumentationProvider[];
}

/**
 * Host-owned objective authority. Free-form objective prose is untrusted input:
 * it may mention a forbidden high-stakes mutation while explicitly asking not
 * to perform it. The evidence gate therefore requires the persisted objective
 * contract to opt in before its narrower domain classifier is consulted.
 */
export interface ObjectiveEvidenceGateAuthority {
  risk: 'standard' | 'high-stakes';
  evidenceRequirement?: 'authoritative-sources-before-mutation';
  /** Host-derived from the latest applicable segment of the persisted contract. */
  domain?: HighStakesEvidenceDomain;
}

export type ObjectiveEvidenceToolEffectKind =
  | 'read'
  | 'local-write'
  | 'external-mutation'
  | 'unknown';

const states = new Map<string, ObjectiveEvidenceGateState>();
const MUTATING_REQUEST_PATTERN = /\b(?:create|draft|write(?!\s+(?:access|privileges?|rights?|roles?)\b)|rewrite|update|replace|change|modify|amend|cancel|void|rescind|correct|implement|apply|publish|submit|deploy|delete|remove|sign|countersign|approve|accept|archive|generate|execute|send|upload|transfer|terminate|renew|cr[ée](?:e|er)|r[ée]dig\w*|r[ée][ée]cri\w*|[ée]cri\w*|fais\s+[ée]voluer|m(?:ets?|ettez)\s+[aà]\s+jour|remplac\w*|modifi\w*|amend\w*|annul\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|publi\w*|soumet\w*|d[ée]ploi\w*|supprim\w*|sign\w*|contresign\w*|approuv\w*|accept\w*|archiv\w*|g[ée]n[éeè]r\w*|ex[ée]cut\w*|envo\w*|t[ée]l[ée]vers\w*|transf[éeè]r\w*|r[ée]sili\w*|renouvel\w*)\b/i;
const DIRECT_RBAC_DOMAIN_PATTERN = unicodeWordBounded(
  String.raw`${DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE}|${DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE}`,
);
const DIRECT_RBAC_MUTATION_ACTION_PATTERN = new RegExp(
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  'giu',
);

/** JavaScript's \b is ASCII-only, so it has no boundary after words such as "sécurité". */
function unicodeWordBounded(source: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`, 'iu');
}

const DIRECT_MEDICAL_DOMAIN_PATTERN = unicodeWordBounded(String.raw`medical|m[ée]dic(?:al|aux|ale|ales)|sant[ée]s?|patients?|hospitals?|healthcare|clinical|therapeutic|pharmac(?:y|ies)|diagnostics?\s+m[ée]dic(?:al|aux|ale|ales)|health\s+(?:applications?|records?)`);
const DOMAINS: Array<[Exclude<HighStakesEvidenceDomain, 'unspecified'>, RegExp]> = [
  ['legal', unicodeWordBounded(String.raw`legal|l[ée]g(?:al|aux|ale|ales)|law|juridiques?|droits?|ndas?|non[- ]disclosure|contrats?|contracts?|compliance|conformit[ée]s?|signatures?|notari(?:s(?:er|ation|ations|[ée](?:e|es|s)?)|z(?:e|ed|ation|ations))`)],
  ['financial', unicodeWordBounded(String.raw`financial|finances?|accounting|comptables?|comptabilit[ée]s?|comptabilis(?:er|ation|ations|[ée](?:e|es|s)?)|fiscal(?:es?|aux|it[ée]s?)?|taxes?|imp[oô]ts?|ledger|factures?|facturations?|factur(?:er|[ée](?:e|es|s)?)|paiements?|payments?`)],
  // “Traitement” alone is operationally ambiguous (data processing, payroll,
  // API handling). Medical treatment remains covered by its clinical context
  // instead of promoting that generic noun to a high-stakes domain.
  ['medical', DIRECT_MEDICAL_DOMAIN_PATTERN],
  ['security', unicodeWordBounded(String.raw`cybersecurity|cybers[ée]curit[ée]s?|security|s[ée]curit[ée]s?|credentials?|secrets?|permissions?|rbac|vuln[ée]rabilit[ée]s?|oauth\s+tokens?|tokens?\s+oauth|jetons?\s+oauth|acls?|access\s+control\s+lists?|(?:admin(?:istrator)?|administrat(?:eur|rice))s?\s+(?:roles?|r[oô]les?|groups?|groupes?)|(?:roles?|r[oô]les?|groups?|groupes?)\s+(?:(?:of|for|de|des|pour\s+les?)\s+|d['’]\s*)?(?:admin(?:istrator)?|administrat(?:eur|rice))s?|${DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE}|${DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE}`)],
];
// A completion/API contract names an executable software interface, not a
// legal document. Remove only these local phrases from the legal keyword scan;
// an unqualified contract, NDA or legal clause elsewhere still requires sources.
const TECHNICAL_CONTRACT_PATTERN = /\b(?:(?:contrats?|contracts?)\s+(?:(?:de\s+|d[’'])(?:compl[ée]tion|validation\s+automatique|sortie(?:\s+JSON)?|preuve\s+automatique|(?:l[’']|une?\s+)?API|(?:l[’'])?interface|service\s+API)|API|OpenAPI|Solidity|JSON|IPC|SDK|ABI|technique|h[oô]te|tests?(?:\s+results?)?|schemas?|fixtures?|interfaces?|definitions?|mocks?|records?|rows?|to\s+Ethereum)|(?:completion|API|OpenAPI|JSON|IPC|SDK|software|interface|output|tool)\s+contracts?|(?:smart|Solidity|Ethereum|blockchain)[- ]contracts?|(?:commandes?\s+)?(?:Bash|shell|SSH)\s+(?:du|de\s+(?:ce|notre))\s+contrat(?:\s+(?:courant|actif))?)\b/gi;
const OPERATIONAL_CONTRACT_LIFECYCLE_SUBJECT_PATTERN = unicodeWordBounded(String.raw`e[- ]?doc|apis?|ssh|serveurs?|servers?|runtimes?|bases?\s+de\s+donn[ée]es?|databases?|db|sql|postgres(?:ql)?|files?|queues?|workers?|webhooks?|callbacks?|mappings?|synchronisations?|synchronizations?|logs?|journaux|buckets?|stockages?|storages?|conteneurs?|containers?|code\s+source|source\s+code|modules?|services?`);
const OPERATIONAL_CONTRACT_LIFECYCLE_ACTION_PATTERN = unicodeWordBounded(String.raw`diagnosti\w*|debug\w*|r[ée]concili\w*|synchronis\w*|inspect\w*|analys\w*|v[ée]rifi\w*|check\w*|corrig\w*|fix\w*|mapping|statuts?|statuses?|failed|erreurs?|errors?|incidents?|files?|queues?|callbacks?|webhooks?`);
const OPERATIONAL_CONTRACT_LIFECYCLE_WORD_PATTERN = unicodeWordBounded(String.raw`contrats?|contracts?|signatures?|sign[ée](?:e|es|s)?|signed|e[- ]?doc`);
const OPERATIONAL_CONTRACT_LIFECYCLE_WORDS_GLOBAL_PATTERN = /(?:^|[^\p{L}\p{M}\p{N}_])(?:contrats?|contracts?|signatures?|sign[ée](?:e|es|s)?|signed|e[- ]?doc)(?![\p{L}\p{M}\p{N}_])/giu;
const GENUINE_LEGAL_DELIVERABLE_PATTERN = unicodeWordBounded(String.raw`juridiques?|legal|law|droits?\s+applicables?|applicable\s+law|ndas?|non[- ]disclosure|clauses?|conditions?\s+(?:contractuelles?|g[ée]n[ée]rales)|contractual\s+(?:terms?|clauses?)|compliance|conformit[ée]s?|notari\w*|r[ée]dig\w*\s+(?:un\s+)?contrat|draft\w*\s+(?:a\s+)?contract`);
const DIRECT_LEGAL_DETERMINER_SOURCE = String.raw`(?:(?:(?:le|la|les|ce|cet|cette|un|une|des|du|tous?|toutes?|nos|notre|mes|mon|ma|vos|votre|leurs?|the|a|an|this|that|all(?:\s+of)?|both|our|my|your|their|customer|client|employment|[\p{L}\p{M}][\p{L}\p{M}'’_-]{0,40}['’]s)\s+|l[’']\s*)){0,3}`;
const DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}(?:contrats?|(?:PNS\s+)?contracts?|accords?|agreements?)(?![\p{L}\p{M}\p{N}_])`;
const DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}(?:(?:documents?\s+(?:juridiques?|l[ée]g(?:al|aux|ale|ales)|ndas?|non[- ]disclosure))|(?:(?:juridiques?|l[ée]g(?:al|aux|ale|ales)|ndas?|non[- ]disclosure)\s+documents?))(?![\p{L}\p{M}\p{N}_])`;
const DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}documents?(?![\p{L}\p{M}\p{N}_])`;
const DIRECT_CONTRACT_OR_AGREEMENT_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}(?![ \t]+(?:statuts?|statuses?|ids?|identifiants?|records?|enregistrements?|fields?|champs?|rows?|lignes?|mappings?|synchronisations?|synchronizations?)\b)`,
  'iu',
);
const DIRECT_QUALIFIED_LEGAL_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE}`,
  'iu',
);
const DIRECT_COMMITTING_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`\b(?:sign|countersign|approve|accept|sign\w*|contresign\w*|approuv\w*|accept\w*)\b\s+${DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE}\b`,
  'iu',
);
const DIRECT_TARGET_FIRST_LEGAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}|${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE})[^.!?;\n]{0,72}(?:,|:|[\u2013\u2014])\s*(?:${MUTATING_REQUEST_PATTERN.source})`,
  'iu',
);
const DIRECT_REFERENTIAL_LEGAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+(?:it|them|cela|ceci|[cç]a|le|la|les)\s+(?:from|in|inside|of|dans|depuis|du|de\s+la|des)\s+${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}`,
  'iu',
);
const DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`${DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE}[^.!?;\n]{0,72},\s*\b(?:sign|countersign|approve|accept|sign\w*|contresign\w*|approuv\w*|accept\w*)\b`,
  'iu',
);
const ENGLISH_LEGAL_PASSIVE_ACTION_SOURCE = String.raw`(?:created|drafted|written|rewritten|updated|replaced|changed|modified|amended|cancell?ed|voided|rescinded|published|submitted|deleted|removed|signed|countersigned|approved|accepted|archived|generated|executed|sent|uploaded|transferred|terminated|renewed)`;
const FRENCH_LEGAL_PASSIVE_ACTION_SOURCE = String.raw`(?:cr[ée][ée]s?|r[ée]dig[ée]s?|[ée]crits?|r[ée][ée]crits?|mis(?:e|es)?\s+[aà]\s+jour|remplac[ée]s?|chang[ée]s?|modifi[ée]s?|amend[ée]s?|annul[ée]s?|publi[ée]s?|soumis(?:e|es)?|supprim[ée]s?|sign[ée]s?|contresign[ée]s?|approuv[ée]s?|accept[ée]s?|archiv[ée]s?|g[ée]n[ée]r[ée]s?|ex[ée]cut[ée]s?|envoy[ée]s?|t[ée]l[ée]vers[ée]s?|transf[ée]r[ée]s?|r[ée]sili[ée]s?|renouvel[ée]s?)`;
const DIRECT_TARGET_FIRST_LEGAL_PASSIVE_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}|${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE})[^.!?;\n]{0,72}\b(?:(?:must|needs?\s+to|has\s+to|is\s+to|should)\s+be\s+${ENGLISH_LEGAL_PASSIVE_ACTION_SOURCE}|(?:doit|doivent|devra|devront)\s+(?:[êe]tre\s+)?${FRENCH_LEGAL_PASSIVE_ACTION_SOURCE})(?![\p{L}\p{M}\p{N}_])`,
  'iu',
);
const DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_PASSIVE_PATTERN = new RegExp(
  String.raw`${DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE}[^.!?;\n]{0,72}\b(?:(?:must|needs?\s+to|has\s+to|is\s+to|should)\s+be\s+(?:signed|countersigned|approved|accepted)|(?:doit|doivent|devra|devront)\s+(?:[êe]tre\s+)?(?:sign[ée]s?|contresign[ée]s?|approuv[ée]s?|accept[ée]s?))(?![\p{L}\p{M}\p{N}_])`,
  'iu',
);
// A production incident often states a duplicate-prevention invariant next to
// a legal-shaped noun (for example “aucune invitation, signature ou
// notification ne doit être réémise”). That prohibition is not authority to
// perform the prohibited effect. Remove only the closed universally-negated
// clause before applying the legacy target-first legal patterns; a later
// positive instruction in another clause remains fully visible.
const NEGATED_LEGAL_EFFECT_SUBJECT_SOURCE = String.raw`(?:effets?|effects?|invitations?|signatures?|notifications?|messages?|emails?|mails?|envois?|deliveries?|documents?|contrats?|contracts?|accords?|agreements?)`;
const NEGATED_LEGAL_EFFECT_LIST_SEPARATOR_SOURCE = String.raw`(?:\s*,\s*(?:(?:et|ou|ni|and|or|nor)\s+)?|\s+(?:et|ou|ni|and|or|nor)\s+)`;
const UNIVERSALLY_NEGATED_LEGAL_EFFECT_PATTERN = new RegExp(
  String.raw`(?:^|[.!?;\n]\s*|\s+et\s+|\s+and\s+)(?:aucun(?:e|es|s)?|no)\s+(?:(?:nouvel(?:le|les|s)?|autres?|new|additional|further|second(?:e|es|s)?)\s+)?${NEGATED_LEGAL_EFFECT_SUBJECT_SOURCE}(?:${NEGATED_LEGAL_EFFECT_LIST_SEPARATOR_SOURCE}(?:(?:nouvel(?:le|les|s)?|autres?|new|additional|further|second(?:e|es|s)?)\s+)?${NEGATED_LEGAL_EFFECT_SUBJECT_SOURCE}){0,5}\s+(?:(?:ne|n['’])\s+)?(?:doit|doivent|devra|devront|must|should|shall|will)\s+(?:pas\s+|not\s+|never\s+)?(?:[êe]tre\s+|be\s+)?(?:r[ée][ée]mis(?:e|es)?|r[ée]envoy[ée]s?|envoy[ée]s?|[ée]mis(?:e|es)?|cr[ée][ée]s?|sign[ée]s?|contresign[ée]s?|approuv[ée]s?|accept[ée]s?|supprim[ée]s?|sent|reissued|issued|created|signed|countersigned|approved|accepted|deleted|removed)(?![\p{L}\p{M}\p{N}_])`,
  'giu',
);

export function isDirectLegalDocumentMutation(text: string): boolean {
  const normalized = text.normalize('NFC')
    .replace(UNIVERSALLY_NEGATED_LEGAL_EFFECT_PATTERN, ' ')
    .replace(TECHNICAL_CONTRACT_PATTERN, ' ');
  return [
    DIRECT_CONTRACT_OR_AGREEMENT_MUTATION_PATTERN,
    DIRECT_QUALIFIED_LEGAL_DOCUMENT_MUTATION_PATTERN,
    DIRECT_COMMITTING_DOCUMENT_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_LEGAL_MUTATION_PATTERN,
    DIRECT_REFERENTIAL_LEGAL_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_LEGAL_PASSIVE_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_PASSIVE_PATTERN,
  ].some(pattern => hasAuthoritativeMutationPattern(normalized, pattern));
}

/**
 * A product incident can legitimately contain business nouns such as
 * “contrat”, “signature” and “e-doc” without asking the agent to interpret or
 * draft a legal instrument. Keep this deliberately conjunctive: both a
 * concrete technical substrate and an operational lifecycle action are
 * required, while any explicit legal/drafting signal wins.
 */
export function isOperationalTechnicalContractLifecycleObjective(text: string): boolean {
  const normalized = text.normalize('NFC');
  return OPERATIONAL_CONTRACT_LIFECYCLE_WORD_PATTERN.test(normalized)
    && OPERATIONAL_CONTRACT_LIFECYCLE_SUBJECT_PATTERN.test(normalized)
    && OPERATIONAL_CONTRACT_LIFECYCLE_ACTION_PATTERN.test(normalized)
    && !GENUINE_LEGAL_DELIVERABLE_PATTERN.test(normalized)
    && !isDirectLegalDocumentMutation(normalized);
}
const TECHNICAL_HEALTH_TARGET = String.raw`services?|applications?|apps?|apis?|endpoints?|conteneurs?|containers?|d[ée]ploiements?|deployments?|serveurs?|servers?|syst[eè]mes?|systems?|instances?|clusters?|pods?|processus|daemons?`;
const TECHNICAL_HEALTH_TARGET_LINK = String.raw`(?:du\s+|de\s+la\s+|de\s+l[’']|des\s+|de\s+(?:ce|cet|cette)\s+)(?:${TECHNICAL_HEALTH_TARGET})`;
const UNICODE_WORD_START = String.raw`(?:^|[^\p{L}\p{M}\p{N}_])`;
const UNICODE_WORD_END = String.raw`(?![\p{L}\p{M}\p{N}_])`;
// A technical target is not enough by itself: “système immunitaire” and
// “application clinique” are medical noun phrases. Only strip an operational
// health phrase when the target actually ends there (or joins another check).
const TECHNICAL_HEALTH_QUALIFIER_SOURCE = String.raw`(?:op[ée]rationnel(?:le)?s?|techniques?|informatiques?|logiciel(?:le)?s?|operational|technical|software)`;
const TECHNICAL_HEALTH_QUALIFIER = String.raw`(?:[ \t]+${TECHNICAL_HEALTH_QUALIFIER_SOURCE})?`;
const TECHNICAL_HEALTH_OPERATIONAL_CONTINUATION = String.raw`(?:puis|ensuite|et)\b|(?:il|elle|ils|elles|cela|[cç]a)\s+(?:doit|doivent|devrait|devraient|est|sont)\b[^.!?\n]{0,32}\b(?:healthy|up|ready|running|disponible|op[ée]rationnel(?:le)?s?|accessible|vert(?:e)?s?)\b|(?:(?:le|la|les|l[’']|un|une)\s+)?(?:https?|login|dashboard|endpoints?|routes?|statuts?|logs?|conteneurs?|containers?|services?|applications?|apis?)\b`;
const TECHNICAL_HEALTH_PHRASE_END = String.raw`(?=[ \t]*(?:$|[.!?;]|(?:et|puis|apr[eè]s|avant|pour)\b|[,:][ \t]*(?:${TECHNICAL_HEALTH_OPERATIONAL_CONTINUATION})))`;
const TECHNICAL_HEALTH_PHRASE_PATTERN = new RegExp(
  String.raw`${UNICODE_WORD_START}(?:sant[ée]s?\s+${TECHNICAL_HEALTH_TARGET_LINK}|(?:sondes?|routes?|endpoints?)\s+(?:de\s+|d[’'])?sant[ée]s?(?:\s+${TECHNICAL_HEALTH_TARGET_LINK})?|(?:contr[oô]les?|v[ée]rifications?|[ée]tats?|statuts?)\s+(?:de\s+|d[’'])?sant[ée]s?\s+${TECHNICAL_HEALTH_TARGET_LINK})${UNICODE_WORD_END}${TECHNICAL_HEALTH_QUALIFIER}${TECHNICAL_HEALTH_PHRASE_END}`,
  'giu',
);
const TECHNICAL_LIST_HEALTH_PATTERN = new RegExp(
  String.raw`(${UNICODE_WORD_START}(?:https?|login|dashboard|endpoints?|sites?)\b[^.!?\n]{0,64}\b(?:et|puis)\s+(?:la\s+)?)sant[ée]s?${UNICODE_WORD_END}${TECHNICAL_HEALTH_PHRASE_END}`,
  'giu',
);
const STANDALONE_OPERATIONAL_HEALTH_QUALIFIER_PATTERN = new RegExp(
  String.raw`^\s+${TECHNICAL_HEALTH_QUALIFIER_SOURCE}(?=\s*(?:$|[.!?;]|(?:et|puis|apr[eè]s|avant|pour|and|then|after|before)\b|[,:]))`,
  'iu',
);
// A persisted legacy contract can have mistaken the operational noun
// “traitement” for medical work. Admit only an explicit, locally bound
// correction that both names an operational meaning and negates the medical
// meaning. Merely saying “not medical” is deliberately insufficient.
const FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN = /(?:le\s+terme\s+)?[«“"'’]?\s*traitements?\s*[»”"'’]?\s+(?:d[ée]signe|signifie|concerne|correspond\s+(?:ici\s+)?[àa])\s+(?:ici\s+)?(?:une?\s+)?(?:op[ée]ration\s+(?:d['’]\s*)?)?(?:int[ée]gration|imports?|synchronisation|traitement\s+(?:de|des)\s+donn[ée]es|processus|workflows?|pipelines?|apis?|connecteurs?|logiciels?)(?:\s+(?:isagri|apis?|plc|sharepoint|donn[ée]es?|data|connecteurs?|logiciels?|techniques?)){0,4}(?:,\s*|\s+et\s+)(?:mais\s+)?(?:pas|non)(?:\s+(?:[àa]|comme))?(?:\s+(?:un|une|du|de\s+la))?(?:\s+(?:acte|soin|traitement|domaine|cas|sujet|op[ée]ration))?\s+m[ée]dic(?:al|ale|aux|ales)/iu;
const ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN = /(?:the\s+term\s+)?[“"']?\s*treatments?\s*[”"']?\s+(?:means|refers?\s+to|denotes|concerns|is)\s+(?:an?\s+)?(?:operation\s+of\s+)?(?:integration|imports?|synchronization|data\s+processing|process|workflows?|pipelines?|apis?|connectors?|software)(?:\s+(?:isagri|apis?|plc|sharepoint|data|connectors?|software|technical)){0,4}(?:,\s*|\s+and\s+)(?:but\s+)?not(?:\s+an?)?\s+medical(?:\s+(?:act|treatment|domain|case|procedure|operation))?/iu;
const NO_MEDICAL_SOURCE_AFTER_CLARIFICATION_PATTERN = /(?:ne\s+(?:me\s+|nous\s+)?(?:re)?demand\w*\s+(?:donc\s+)?(?:plus\s+)?(?:pas\s+(?:de|des)|aucune?s?)\s+sources?\s+m[ée]dicales?|(?:do\s+not|don't|no\s+need\s+to)\s+(?:ask\s+(?:again\s+)?for|request)\s+(?:any\s+)?medical\s+sources?)/iu;
const NON_MEDICAL_CLARIFICATION_SUFFIX_PATTERN = /(?:(?:,\s*|\s+et\s+)(?:mais\s+)?(?:pas|non)(?:\s+(?:[àa]|comme))?(?:\s+(?:un|une|du|de\s+la))?(?:\s+(?:acte|soin|traitement|domaine|cas|sujet|op[ée]ration))?\s+m[ée]dic(?:al|ale|aux|ales)|(?:,\s*|\s+and\s+)(?:but\s+)?not(?:\s+an?)?\s+medical(?:\s+(?:act|treatment|domain|case|procedure|operation))?)$/iu;
const CLINICAL_SIGNAL_INSIDE_CLARIFICATION_PATTERN = unicodeWordBounded(String.raw`patients?|vih|hiv|sida|aids|soins?|care|m[ée]decins?|doctors?|diagnostics?|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|antibiotiques?|antibiotics?|insulines?|insulins?|m[ée]dicaments?|medications?`);
const MEDICAL_TREATMENT_SOURCE = String.raw`(?:traitements?|treatments?)`;
const MEDICAL_TREATMENT_PATTERN = new RegExp(String.raw`\b${MEDICAL_TREATMENT_SOURCE}\b`, 'i');
const MEDICAL_TREATMENT_OCCURRENCE_PATTERN = new RegExp(String.raw`\b${MEDICAL_TREATMENT_SOURCE}\b`, 'gi');
// “Traitement/treatment” is ambiguous on its own. Treat it as medical only
// inside the same clause as an unambiguous clinical subject or management
// phrase. Context is folded to ASCII so accented and decomposed French input
// follow the same path.
const CLINICAL_CONDITION_PATTERN = new RegExp(String.raw`\b(?:${[
  String.raw`cancers?|tumeurs?|tumou?rs?`,
  String.raw`leucemies?|leukemias?`,
  String.raw`infections?|infectieuses?|bacteriennes?|virales?`,
  String.raw`hypertensions?|tensions?\s+arterielles?|blood\s+pressure`,
  String.raw`insuffisances?\s+(?:cardiaques?|renales?|respiratoires?)|heart\s+failure|kidney\s+failure|renal\s+failure`,
  String.raw`migraines?`,
  String.raw`diabetes?|diabetiques?`,
  String.raw`douleurs?\s+chroniques?|chronic\s+pain`,
  String.raw`maladies?|pathologies?|symptomes?|diseases?|disorders?|medical\s+conditions?|conditions?\s+medicales?`,
  String.raw`asthmes?|asthmas?|epilepsies?`,
  String.raw`depressions?|anxietes?|anxiety`,
  String.raw`fievres?|fevers?|allergies?|arthrites?|arthritis`,
  String.raw`vih|hiv|sida|aids`,
  String.raw`scleroses?\s+en\s+plaques?|multiple\s+sclerosis`,
  String.raw`bronchites?|bronchitis|bpco|copd`,
  String.raw`covid(?:[- ]?19)?`,
  String.raw`endometrioses?|endometriosis`,
  String.raw`obesites?|obesity`,
  String.raw`insomnies?|insomnia`,
  String.raw`eczemas?|eczema`,
  String.raw`grossesses?|pregnancy|pregnancies`,
  String.raw`parkinson|alzheimer|avc|strokes?`,
  String.raw`mucoviscidoses?|cystic\s+fibrosis`,
  // Closed disease morphologies used in English clinical names. Keep these
  // suffixes longer than ordinary nouns so operational "treatment" subjects
  // such as glucose/cellulose do not become medical by resemblance alone.
  String.raw`[a-z]{4,}(?:itis|emia|osis)`,
  // Keep the generic noun useful only as a closed clinical subject. A named
  // syndrome needs an explicit known clinical morphology; this prevents
  // software phrases such as “syndrome de compilation” from becoming medical.
  String.raw`syndromes?(?=\s*(?:$|[,;:)]))|syndromes?\s+(?:de\s+down|des?\s+ovaires?\s+polykystiques?|m[ée]tabolique|n[ée]phrotique|n[ée]phritique|coronarien|post[- ]traumatique)|down\s+syndrome|metabolic\s+syndrome|polycystic\s+ovary\s+syndrome`,
].join('|')})\b`, 'i');
const CLINICAL_TREATMENT_QUALIFIER_PATTERN = new RegExp(String.raw`\b(?:${[
  String.raw`antibiotiques?|antibiotics?`,
  String.raw`antiviraux?|antivirals?|antifongiques?|antifungals?`,
  String.raw`antalgiques?|analgesics?|anti[- ]?inflammatoires?|anti[- ]?inflammator(?:y|ies)`,
  String.raw`antihypertenseurs?|antihypertensives?|insulines?`,
  String.raw`anticoagulants?|anticoagulant`,
  String.raw`medicaments?|medications?|pharmaceutiques?|pharmaceuticals?`,
  String.raw`medicamenteu(?:x|se|ses)|therapeutiques?|therapeutics?`,
  String.raw`pharmacologiques?|pharmacological|chirurgicaux?|chirurgical(?:e|es)?|surgical`,
  String.raw`symptomatiques?|symptomatic|curatifs?|curative|palliatifs?|palliative`,
].join('|')})\b`, 'i');
const CLINICAL_TREATMENT_MODALITY_SOURCE = String.raw`(?:${[
  String.raw`chimioth[ée]rapies?|chemotherap(?:y|ies)`,
  String.raw`radioth[ée]rapies?|radiotherap(?:y|ies)`,
  String.raw`dialyses?|dialysis`,
  String.raw`immunoth[ée]rapies?|immunotherap(?:y|ies)`,
  String.raw`hormonoth[ée]rapies?|hormone\s+therap(?:y|ies)`,
  String.raw`psychoth[ée]rapies?|psychotherap(?:y|ies)`,
  String.raw`chirurgies?|surgery|surgeries`,
  String.raw`physioth[ée]rapies?|physiotherap(?:y|ies)`,
  String.raw`kin[ée]sith[ée]rapies?|physical\s+therap(?:y|ies)`,
  String.raw`oxyg[ée]noth[ée]rapies?|oxygen\s+therap(?:y|ies)`,
  String.raw`g[ée]noth[ée]rapies?|gene\s+therap(?:y|ies)`,
  String.raw`transfusions?(?:\s+sanguines?)?|blood\s+transfusions?`,
  String.raw`perfusions?|infusions?`,
  String.raw`intubations?`,
  String.raw`greffes?|transplantations?|(?:kidney|renal|liver|heart|lung|organ|bone\s+marrow)\s+transplants?`,
  String.raw`vaccinations?|vaccines?`,
  String.raw`anticoagulants?`,
  String.raw`insulinoth[ée]rapies?|insulin\s+therap(?:y|ies)`,
].join('|')})`;
export const DIRECT_CLINICAL_MEDICATION_SOURCE = String.raw`(?:antibiotiques?|antibiotics?|insulines?|insulins?|morphines?|warfarines?|warfarins?|prednisone|fentanyl|aspirine?|aspirin|h[ée]parine?|heparin|parac[ée]tamol|acetaminophen|metformin|ceftriaxone|[\p{L}\p{M}]{4,}(?:cillin|cycline|mycin|xone|pril|sartan|olol|statin|formin)|m[ée]dicaments?|medications?)`;
const DIRECT_CLINICAL_TARGET_SOURCE = String.raw`(?:${CLINICAL_TREATMENT_MODALITY_SOURCE}|${DIRECT_CLINICAL_MEDICATION_SOURCE})`;
export const DIRECT_CLINICAL_NAMED_PERSON_SOURCE = String.raw`\p{Lu}[\p{L}\p{M}'’_-]{1,48}(?:\s+\p{Lu}[\p{L}\p{M}'’_-]{1,48})?`;
export const DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE = String.raw`\s+(?:from\s+(?:(?:the|a|an)\s+)?${DIRECT_CLINICAL_MEDICATION_SOURCE}\s+(?:to|onto)\s+(?:(?:the|a|an)\s+)?${DIRECT_CLINICAL_MEDICATION_SOURCE}|(?:(?:du|de\s+la|des)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${DIRECT_CLINICAL_MEDICATION_SOURCE}\s+(?:[àa]|vers)\s+(?:(?:le|la|les|un|une)\s+|l['’]\s*)?${DIRECT_CLINICAL_MEDICATION_SOURCE})`;
export const DIRECT_CLINICAL_MODIFIER_SOURCE = String.raw`(?:(?:gradually|progressively|slowly|carefully|by\s+half|progressivement|graduellement|lentement|prudemment|par\s+deux)\s+)?`;
export const ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE = String.raw`(?:adjust(?:s|ed|ing)?|chang(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|prescribe(?:s|d|ing)?|reduce(?:s|d|ing)?|lower(?:s|ed|ing)?|increase(?:s|d|ing)?|decrease(?:s|d|ing)?|rais(?:e|es|ed|ing)|start(?:s|ed|ing)?|begin(?:s|ning)?|began|begun|initiat(?:e|es|ed|ing)|commenc(?:e|es|ed|ing)|switch(?:es|ed|ing)?|stop(?:s|ped|ping)?|hold(?:s|ing)?|held|withhold(?:s|ing)?|withheld|suspend(?:s|ed|ing)?|cease(?:s|d|ing)?|resume(?:s|d|ing)?|restart(?:s|ed|ing)?|renew(?:s|ed|ing)?|doubl(?:e|es|ed|ing)|halv(?:e|es|ed|ing)|(?:up|down)?titrat(?:e|es|ed|ing)|transition(?:s|ed|ing)?|replac(?:e|es|ed|ing)|substitut(?:e|es|ed|ing)|convert(?:s|ed|ing)?|taper(?:s|ed|ing)?|wean(?:s|ed|ing)?|escalat(?:e|es|ed|ing)|de[- ]escalat(?:e|es|ed|ing)|put(?:s|ting)?|medicat(?:e|es|ed|ing)|dos(?:e|es|ed|ing)|administer(?:s|ed|ing)?|inject(?:s|ed|ing)?|infus(?:e|es|ed|ing)|giv(?:e|es|ing|en)|gave|order(?:s|ed|ing)?|discontinu(?:e|es|ed|ing)|set)`;
export const FRENCH_CLINICAL_TREATMENT_ACTION_SOURCE = String.raw`(?:adapt(?:er|e(?:s|z)?|ons?|ent)|ajust(?:er|e(?:s|z)?|ons?|ent)|chang(?:er|e(?:s|z)?|ons?|ent)|modifi(?:er|e(?:s|z)?|ons?|ent)|prescri(?:re|s|t|vez|vons|vent)|r[ée]dui(?:re|s|t|sez|sons|sent)|diminu(?:er|e(?:s|z)?|ons?|ent)|baiss(?:er|e(?:s|z)?|ons?|ent)|pass(?:er|e(?:s|z)?|ons?|ent)|augment(?:er|e(?:s|z)?|ons?|ent)|commenc(?:er|e(?:s|z)?|ons?|ent)|initi(?:er|e(?:s|z)?|ons?|ent)|titr(?:er|e(?:s|z)?|ons?|ent)|doubl(?:er|e(?:s|z)?|ons?|ent)|divis(?:er|e(?:s|z)?|ons?|ent)|remplac(?:er|e(?:s|z)?|ons?|ent)|substitu(?:er|e(?:s|z)?|ons?|ent)|s[èe]vr(?:er|e(?:s|z)?|ons?|ent)|suspend(?:re|s|ez|ons|ent)|interromp(?:re|s|t|ez|ons|ent)|reprend(?:re|s|ez|ons|ent)|red[ée]marr(?:er|e(?:s|z)?|ons?|ent)|renouvel(?:er|le(?:s|z)?|ons|lent)|transitionn(?:er|e(?:s|z)?|ons?|ent)|convert(?:ir|is|it|issez|issons|issent)|cess(?:er|e(?:s|z)?|ons?|ent)|arr[êe]t(?:er|e(?:s|z)?|ons?|ent)|(?:mettre|mets?|mettez|mettons|mettent)|administr(?:er|e(?:s|z)?|ons?|ent)|inject(?:er|e(?:s|z)?|ons?|ent)|perfus(?:er|e(?:s|z)?|ons?|ent)|donn(?:er|e(?:s|z)?|ons?|ent)|ordonn(?:er|e(?:s|z)?|ons?|ent))`;
export const DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE = String.raw`(?:${ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE}|${FRENCH_CLINICAL_TREATMENT_ACTION_SOURCE})`;
export const ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE = String.raw`(?:perform(?:s|ed|ing)?|conduct(?:s|ed|ing)?|operate(?:s|d|ing)?|schedule(?:s|d|ing)?|carr(?:y|ies|ied|ying)\s+out|do|does|did|done|doing|undertak(?:e|es|ing)|undertook|undertaken|intubat(?:e|es|ed|ing)|extubat(?:e|es|ed|ing)|transfus(?:e|es|ed|ing)|biops(?:y|ies|ied|ying))`;
export const FRENCH_CLINICAL_PROCEDURE_ACTION_SOURCE = String.raw`(?:r[ée]alis(?:er|e(?:s|z)?|ons?|ent)|effectu(?:er|e(?:s|z)?|ons?|ent)|pratiqu(?:er|e(?:s|z)?|ons?|ent)|op[èe]r(?:er|e(?:s|z)?|ons?|ent)|planifi(?:er|e(?:s|z)?|ons?|ent)|programm(?:er|e(?:s|z)?|ons?|ent)|intub(?:er|e(?:s|z)?|ons?|ent)|extub(?:er|e(?:s|z)?|ons?|ent)|transfus(?:er|e(?:s|z)?|ons?|ent)|biopsi(?:er|e(?:s|z)?|ons?|ent)|pos(?:er|e(?:s|z)?|ons?|ent)|faire|fais|faites|faisons|font)`;
export const DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE = String.raw`(?:${ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE}|${FRENCH_CLINICAL_PROCEDURE_ACTION_SOURCE})`;
export const ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE = String.raw`(?:vaccinat(?:e|es|ed|ing)|immuniz(?:e|es|ed|ing)|inoculat(?:e|es|ed|ing))`;
export const FRENCH_CLINICAL_PATIENT_CARE_ACTION_SOURCE = String.raw`(?:vaccin(?:er|e(?:s|z)?|ons?|ent)|immunis(?:er|e(?:s|z)?|ons?|ent)|inocul(?:er|e(?:s|z)?|ons?|ent))`;
export const DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE = String.raw`(?:${ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE}|${FRENCH_CLINICAL_PATIENT_CARE_ACTION_SOURCE})`;
const DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE})$`, 'iu');
const DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE})$`, 'iu');
const DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu');
const BARE_ENGLISH_CLINICAL_ACTION_PATTERN = /^(?:adjust|change|modify|prescribe|reduce|lower|increase|decrease|raise|start|begin|initiate|commence|switch|stop|hold|withhold|suspend|cease|resume|restart|renew|double|halve|(?:up|down)?titrate|transition|replace|substitute|convert|taper|wean|escalate|de[- ]escalate|put|medicate|dose|administer|inject|infuse|give|order|discontinue|set|perform|conduct|operate|schedule|carry\s+out|do|undertake|intubate|extubate|transfuse|biopsy|vaccinate|immunize|inoculate)$/iu;
const ANY_ENGLISH_CLINICAL_ACTION_PATTERN = new RegExp(`^(?:${ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE}|${ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE}|${ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu');
const DIRECT_CLINICAL_MANAGEMENT_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|the|a|an)\s+|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?${DIRECT_CLINICAL_TARGET_SOURCE}(?:\s+(?:therap(?:y|ies)|traitements?|th[ée]rapies?|prescriptions?|ordonnances?|dosages?|doses?|posologies?))?(?![\p{L}\p{N}_])`,
  'iu',
);
// Medication names are open-ended and should not be maintained as a brittle
// allowlist. A direct instruction to change a dose/posology is clinical unless
// its object is an explicitly operational batch/data target.
const DIRECT_CLINICAL_DOSAGE_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:la|le|les|une?|the|an?)\s+)?(?:(?:doses?|dosages?|posologies?)\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)(?!(?:traitements?|treatments?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*|(?!(?:la|le|les|une?|the|an?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:doses?|dosages?|posologies?))`,
  'iu',
);
const DIRECT_CLINICAL_PRESCRIPTION_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:la|le|les|une?|the|an?)\s+|l['’]\s*)?(?:prescriptions?|ordonnances?)\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${DIRECT_CLINICAL_MEDICATION_SOURCE}(?![\p{L}\p{N}_])`,
  'iu',
);
const DIRECT_CLINICAL_PRESCRIPTION_PATTERN = new RegExp(
  String.raw`\b(?:prescri(?:s|t|re|vez|vons)|prescribe(?:s|d|ing)?)\s+(?!(?:(?:du|de\s+la|des|le|la|les|l['’]|une?|the|an?)\s+)?(?:traitements?|treatments?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?|candidatures?|applications?|customers?|clients?)\b)(?:(?:du|de\s+la|des|le|la|les|l['’]|une?|the|an?)\s+)?[\p{L}\p{M}][\p{L}\p{M}'’_-]*`,
  'iu',
);
// Likewise, recognize broad surgical-procedure morphology rather than naming
// individual operations such as appendectomy.
const DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE = String.raw`(?:[\p{L}\p{M}'’_-]{3,}(?:ectomie|ectomy|otomie|otomy|plastie|plasty|scopie|scopy|stomie|stomy)|biopsie|biopsy|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|perfusions?|infusions?|intubations?|${CLINICAL_TREATMENT_MODALITY_SOURCE})`;
const DIRECT_CLINICAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);
const DIRECT_CLINICAL_MUTATION_ACTION_PATTERN = new RegExp(
  String.raw`\b(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}|${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}|${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})\b`,
  'giu',
);
const DIRECT_CLINICAL_PATIENT_MEDICATION_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b(?:switch(?:es|ed|ing)?|transition(?:s|ed|ing)?|convert(?:s|ed|ing)?|wean(?:s|ed|ing)?|put(?:s|ting)?|pass(?:er|e(?:s|z)?|ons?|ent)|transitionn(?:er|e(?:s|z)?|ons?|ent)|convert(?:ir|is|it|issez|issons|issent)|s[èe]vr(?:er|e(?:s|z)?|ons?|ent)|mettre|mets?|mettez|mettons|mettent)(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}\b${DIRECT_CLINICAL_MEDICATION_SOURCE}\b)[^.!?;\n]{1,120}`,
  'iu',
);
const DIRECT_CLINICAL_PATIENT_CARE_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|un|une|the|a)\s+)?patients?\b`,
  'iu',
);
const DIRECT_CLINICAL_MEDICATION_TRANSITION_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);
const DIRECT_CLINICAL_NAMED_PERSON_ACTION_PATTERN = new RegExp(
  String.raw`(?:^|[.!?;\n]\s*)(?:[Vv]accinat(?:e|es|ed|ing)|[Vv]accin(?:er|e(?:s|z)?|ons?|ent)|[Ii]mmuniz(?:e|es|ed|ing)|[Ii]mmunis(?:er|e(?:s|z)?|ons?|ent)|[Ii]noculat(?:e|es|ed|ing)|[Ii]nocul(?:er|e(?:s|z)?|ons?|ent)|[Ee]xtubat(?:e|es|ed|ing)|[Ee]xtub(?:er|e(?:s|z)?|ons?|ent)|[Tt]ransfus(?:e|es|ed|ing|er|e(?:s|z)?|ons?|ent))\s+${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);
const DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}(?:\b\d+(?:[.,]\d+)?\s*(?:mcg|mg|g|ml|iu|units?|unit[ée]s?)\b|\b${DIRECT_CLINICAL_MEDICATION_SOURCE}\b))[^.!?;\n]{1,120}`,
  'iu',
);
const DIRECT_CLINICAL_LOCAL_MEDICATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?(?:(?:${DIRECT_CLINICAL_TARGET_SOURCE})(?:\s+(?:therap(?:y|ies)|traitements?|th[ée]rapies?|prescriptions?|ordonnances?|dosages?|doses?|posologies?))?|(?:traitements?|treatments?|therap(?:y|ies)|th[ée]rapies?)|(?!(?:lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|requests?|requ[êe]tes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)|(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)(?:\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${DIRECT_CLINICAL_MEDICATION_SOURCE})?)(?![\p{L}\p{N}_])`,
  'iu',
);
const DIRECT_CLINICAL_LOCAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);
const DIRECT_CLINICAL_PATIENT_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b`,
  'iu',
);
const DIRECT_CLINICAL_LOCAL_TRANSITION_PATTERN = new RegExp(
  String.raw`^${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);
const DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:the|a|le|la|un|une)\s+)?${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);
const CLINICAL_TREATMENT_MODALITY_PATTERN = new RegExp(
  String.raw`\b(?:traitements?\s+(?:(?:par|de|avec)\s+)?${CLINICAL_TREATMENT_MODALITY_SOURCE}|${CLINICAL_TREATMENT_MODALITY_SOURCE}\s+traitements?|treatments?\s+(?:(?:by|with|using|of)\s+)?${CLINICAL_TREATMENT_MODALITY_SOURCE}|${CLINICAL_TREATMENT_MODALITY_SOURCE}\s+treatments?)\b`,
  'i',
);
const CLINICAL_TREATMENT_PRESCRIPTION_PATTERN = /\b(?:prescri(?:s|t|re|vez|vons|ption|ptions|be|bed|bing)|ordonnances?)\b/i;
const CLINICAL_TREATMENT_DOSAGE_PATTERN = new RegExp(
  String.raw`\b(?:(?:dosages?|doses?|posologies?)\s+(?:(?:du|de\s+la|des|de\s+(?:ce|cette)|dudit|of\s+(?:the|this))\s+)?${MEDICAL_TREATMENT_SOURCE}|${MEDICAL_TREATMENT_SOURCE}(?:\s+plans?)?\s+(?:dosages?|doses?|posologies?))\b`,
  'i',
);
const EXPLICIT_TREATMENT_SUBJECT_TAIL_PATTERN = /^\s+(?:du|des|de\s+la|de\s+l['’]|pour(?:\s+(?:le|la|les)|\s+l['’])?|of(?:\s+the)?|for(?:\s+the)?)\s+[^,.!?;\n]{1,96}/i;
const EVIDENCE_TOOL_PATTERN = /(?:search|query|fetch|browser|read|open|download|source|research|(?:^|__|_)(?:get|list|inspect|status|check)(?:__|_|$))/i;
const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;
const OFFICIAL_SOURCE_HOSTS = ['europa.eu', 'legifrance.gouv.fr', 'service-public.fr', 'cnil.fr', 'who.int', 'finra.org', 'owasp.org'];
// Provider documentation is authoritative for a security/agent-policy task,
// but a provider's general hosting domain is not. Keep exact documentation
// hosts here: github.com can host arbitrary third-party repositories and
// community.openai.com contains user-authored material.
const SECURITY_PROVIDER_DOCUMENTATION_HOSTS = new Map<string, SecurityDocumentationProvider>([
  ['docs.github.com', 'github'],
  ['docs.docker.com', 'docker'],
  ['learn.microsoft.com', 'microsoft'],
  ['openai.com', 'openai'],
  ['www.openai.com', 'openai'],
  ['platform.openai.com', 'openai'],
  ['developers.openai.com', 'openai'],
  ['model-spec.openai.com', 'openai'],
]);
// Exact vendor documentation hosts observed in authenticated production
// workflows. These are authoritative only for the applicable business/legal
// integration; do not admit parent domains, arbitrary Document360 tenants or
// lookalikes.
const BUSINESS_DOCUMENTATION_SOURCES = new Map<string, {
  vendor: 'cerfrance' | 'silae';
  path: RegExp;
}>([
  ['cneidf.cerfranceconnect.fr', { vendor: 'cerfrance', path: /^\/documentation(?:\/|$)/ }],
  ['silae-api.document360.io', { vendor: 'silae', path: /^\/docs(?:\/|$)/ }],
  ['www.silae.fr', { vendor: 'silae', path: /^\/solutions\/api(?:\/|$)/ }],
]);
const SOURCE_INSPECTION_TOOL_PATTERN = /(?:fetch|browser|(?:^|__|_)open(?:__|_|$)|web__run)/i;
const FIRST_PARTY_SOURCE_TOOLS: Record<HighStakesEvidenceDomain, RegExp | undefined> = {
  legal: undefined,
  financial: /^mcp__(?:inqom|sellsy|bank|banking|accounting|comptabilite)__/,
  medical: /^mcp__(?:ehr|emr|patient-record|clinical-record)__/,
  security: /^mcp__(?:security|scanner|sast|dast|vulnerability)__/,
  unspecified: undefined,
};

function providerDocumentationForUrl(url: URL): SecurityDocumentationProvider | undefined {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // Microsoft Q&A is community-authored despite sharing the Learn host. It
  // cannot satisfy a high-stakes first-party documentation requirement.
  if (hostname === 'learn.microsoft.com'
    && /^\/(?:[a-z]{2}-[a-z]{2}\/)?answers(?:\/|$)/i.test(url.pathname)) return undefined;
  if (hostname === 'docs.docker.com') {
    return /^\/engine\/(?:security(?:\/|$)|storage\/bind-mounts\/?$|network\/packet-filtering-firewalls\/?$)/i.test(url.pathname)
      ? 'docker' : undefined;
  }
  // freedesktop.org hosts many independent projects. Only systemd's bounded
  // manual tree is first-party evidence for a systemd security task.
  if (hostname === 'www.freedesktop.org') {
    return /^\/software\/systemd\/man\/(?:latest|[0-9]+)\/[A-Za-z0-9_.+-]+\.html$/i.test(url.pathname)
      ? 'systemd' : undefined;
  }
  const exactProvider = SECURITY_PROVIDER_DOCUMENTATION_HOSTS.get(hostname);
  if (exactProvider === 'github') {
    const path = url.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
    return /^\/(?:enterprise-(?:cloud|server)@[^/]+\/)?(?:code-security|authentication)(?:\/|$)/i.test(path)
      || /^\/organizations\/keeping-your-organization-secure(?:\/|$)/i.test(path)
      ? 'github' : undefined;
  }
  if (exactProvider === 'microsoft') {
    const path = url.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
    return /^\/(?:graph\/(?:auth|permissions?|security)|entra|security|azure\/security)(?:[-/]|$)/i.test(path)
      ? 'microsoft' : undefined;
  }
  if (exactProvider === 'openai') {
    if (hostname === 'model-spec.openai.com') {
      return /^\/(?:[0-9]{4}-[0-9]{2}-[0-9]{2}\.html)?$/i.test(url.pathname)
        ? 'openai' : undefined;
    }
    return /(?:^|[-/])(?:auth(?:entication|orization)?|model-spec|polic(?:y|ies)|privacy|safety|security|trust)(?:[-/.]|$)/i.test(url.pathname)
      ? 'openai' : undefined;
  }
  if (exactProvider) return exactProvider;

  // GitHub's raw/content hosts are first-party transport, not proof of who
  // published a document. Admit only the official OpenAI Model Spec repository
  // observed in production, on its main branch or an immutable commit.
  if (hostname === 'github.com') {
    if (/^\/openai\/model_spec\/?$/i.test(url.pathname)
      || /^\/openai\/model_spec\/blob\/(?:main|[a-f0-9]{40})\/(?:model_spec|readme)\.md$/i.test(url.pathname)) return 'openai';
    if (/^\/systemd\/systemd\/?$/i.test(url.pathname)
      || /^\/systemd\/systemd\/blob\/(?:main|[a-f0-9]{40})\/(?:README\.md|(?:docs\/[A-Za-z0-9_.+/-]+\.md)|(?:man\/[A-Za-z0-9_.+@/-]+\.xml))$/i.test(url.pathname)) return 'systemd';
  }
  if (hostname === 'raw.githubusercontent.com') {
    if (/^\/openai\/model_spec\/(?:main|[a-f0-9]{40})\/(?:model_spec|readme)\.md$/i.test(url.pathname)) return 'openai';
    if (/^\/systemd\/systemd\/(?:main|[a-f0-9]{40})\/(?:README\.md|(?:docs\/[A-Za-z0-9_.+/-]+\.md)|(?:man\/[A-Za-z0-9_.+@/-]+\.xml))$/i.test(url.pathname)) return 'systemd';
  }
  return undefined;
}

function objectiveSecurityDocumentationProviders(text: string): SecurityDocumentationProvider[] {
  const normalized = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const providers: SecurityDocumentationProvider[] = [];
  if (/\b(?:docker|containers?|conteneurs?|bind[ -]?mounts?|montages?\s+bind)\b/.test(normalized)) providers.push('docker');
  if (/\b(?:github|secret[ -]?scanning|code[ -]?scanning|dependabot)\b/.test(normalized)) providers.push('github');
  if (/\b(?:microsoft|m365|office\s*365|azure|entra|graph\s+api|microsoft\s+graph)\b/.test(normalized)) providers.push('microsoft');
  if (/\b(?:openai|chatgpt|model\s+spec|agents?\s+(?:security|policy|safety)|securite\s+des?\s+agents?)\b/.test(normalized)) providers.push('openai');
  if (/\b(?:systemd|systemctl|service\s+units?|unit\s+files?|unites?\s+systemd)\b/.test(normalized)) providers.push('systemd');
  return providers;
}

function objectiveBusinessSourceVendors(text: string): Array<'cerfrance' | 'silae'> {
  const normalized = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const vendors: Array<'cerfrance' | 'silae'> = [];
  if (/\b(?:cerfrance|cneidf)\b/.test(normalized)) vendors.push('cerfrance');
  if (/\bsilae\b/.test(normalized)) vendors.push('silae');
  return vendors;
}

function isRelevantProviderDocumentationUrl(
  url: URL,
  providers: readonly SecurityDocumentationProvider[],
): boolean {
  const provider = providerDocumentationForUrl(url);
  return provider !== undefined && providers.includes(provider);
}

/** A nominally completed fetch can still be a 4xx/error envelope. Require an
 * observable success-shaped result before its target may satisfy the source
 * gate; this is deliberately narrower than general evidence collection. */
function sourceObservationSucceeded(result: string): boolean {
  const normalized = result.trim();
  if (normalized.length < 40) return false;
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as Record<string, unknown>;
        const numericStatus = typeof envelope.status === 'number'
          ? envelope.status
          : typeof envelope.status === 'string' && /^\d{3}$/.test(envelope.status)
            ? Number(envelope.status) : undefined;
        if (envelope.success === false || envelope.ok === false
          || numericStatus !== undefined && numericStatus >= 400
          || typeof envelope.error === 'string' && envelope.error.trim().length > 0
          || Array.isArray(envelope.errors) && envelope.errors.length > 0) return false;
      }
    } catch {
      // A fetched document can itself be non-JSON text beginning with `{`.
      // Continue with the bounded textual failure-envelope checks below.
    }
  }
  return !/^(?:\[(?:error|failed|failure)\]\s*|(?:error|failure)\s*(?::|-|\r?\n)|fail(?:ed|ure)(?:\s+to\b|\s*(?::|-|\r?\n))|(?:request|fetch|navigation|tool(?:\s+execution)?)\s+(?:failed|error)\b|(?:unable|could\s+not)\s+to\s+(?:fetch|open|navigate|retrieve)\b|not\s+found(?:\s*(?::|-|\r?\n)|$)|http(?:\/\S+)?\s+[45]\d\d\b|[45]\d\d\s+(?:error|not\s+found)\b)/iu.test(normalized);
}

function hasContextualMedicalTreatment(text: string): boolean {
  if (DIRECT_CLINICAL_NAMED_PERSON_ACTION_PATTERN.test(text)
    || DIRECT_CLINICAL_MEDICATION_TRANSITION_PATTERN.test(text)) return true;
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (DIRECT_CLINICAL_DOSAGE_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PRESCRIPTION_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PRESCRIPTION_PATTERN.test(folded)
    || DIRECT_CLINICAL_PATIENT_MEDICATION_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PATIENT_CARE_PATTERN.test(folded)
    || /\b(?:giv(?:e|es|ing|en)|gave|donn(?:er|e(?:s|z)?|ons?|e(?:e|es|s)?))\b/i.test(folded)
      && DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(folded)) {
    return true;
  }
  const clauses = folded.split(/[.!?;\n]+/);
  return clauses.some((clause, clauseIndex) => {
    const directClinicalTarget = DIRECT_CLINICAL_MANAGEMENT_PATTERN.exec(clause);
    if (directClinicalTarget) {
      const tail = clause.slice((directClinicalTarget.index ?? 0) + directClinicalTarget[0].length);
      // Clinical nouns do not turn an inventory/batch/pipeline operation into
      // a medical objective merely by appearing next to it.
      if (!/^\s+(?:inventor(?:y|ies)|stocks?|lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|files?|fichiers?)\b/i.test(tail)) {
        return true;
      }
    }
    const directClinicalProcedure = DIRECT_CLINICAL_PROCEDURE_PATTERN.exec(clause);
    if (directClinicalProcedure) {
      const tail = clause.slice((directClinicalProcedure.index ?? 0) + directClinicalProcedure[0].length);
      if (!/^\s+(?:inventor(?:y|ies)|stocks?|lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|files?|fichiers?|updates?|mises?\s+[àa]\s+jour)\b/i.test(tail)) {
        return true;
      }
    }
    if (!MEDICAL_TREATMENT_PATTERN.test(clause)) return false;
    for (const match of clause.matchAll(MEDICAL_TREATMENT_OCCURRENCE_PATTERN)) {
      const treatmentStart = match.index;
      const treatmentEnd = treatmentStart + match[0].length;
      const treatmentTail = clause.slice(treatmentEnd);
      const hasExplicitSubjectTail = EXPLICIT_TREATMENT_SUBJECT_TAIL_PATTERN.test(treatmentTail);
      const nearbyContext = clause.slice(
        Math.max(0, treatmentStart - 96),
        treatmentEnd + 96,
      );
      if (CLINICAL_TREATMENT_MODALITY_PATTERN.test(nearbyContext)) return true;
      if (CLINICAL_CONDITION_PATTERN.test(nearbyContext)) return true;

      // A diagnosis or other closed clinical subject may appear in the
      // immediately adjacent sentence of the same request, but it must not
      // retarget an explicit business/material complement in this clause.
      if (!hasExplicitSubjectTail) {
        const adjacentClinicalContext = [
          clauses[clauseIndex - 1] ?? '',
          clauses[clauseIndex + 1] ?? '',
        ].join(' ');
        if (CLINICAL_CONDITION_PATTERN.test(adjacentClinicalContext)) return true;
      }

      // Prescription/dosage/pharmaceutical vocabulary is clinical only when
      // it forms a closed treatment phrase. If “traitement” has an explicit
      // business/material subject, those words cannot promote it by themselves.
      if (!hasExplicitSubjectTail && (
        CLINICAL_TREATMENT_DOSAGE_PATTERN.test(clause)
        || CLINICAL_TREATMENT_QUALIFIER_PATTERN.test(nearbyContext)
        || CLINICAL_TREATMENT_PRESCRIPTION_PATTERN.test(nearbyContext)
      )) return true;
    }
    return false;
  });
}

/** The legacy evidence-domain helper predates the host authority classifier.
 * Keep its new clinical verbs request-shaped so a negation, question, quote or
 * reported recommendation cannot manufacture mutation authority. */
function hasAuthoritativeMutationPattern(
  text: string,
  pattern: RegExp,
  family?: 'clinical',
): boolean {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = text.slice(Math.max(0, index - 180), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 180);
    const negated = /(?:\bdo\s+not|\bdon['’]t|\bnever|\b(?:must|should)(?:\s+not|n['’]t)(?:\s+be)?|\b(?:is|are|was|were)\s+not\s+to(?:\s+be)?|\bwithout|\bsans|\bne\s+pas|\bne\s+jamais|\bn['’]\s*)\s*$/iu.test(before)
      || /(?:\bne|\bn['’])(?:\s+[\p{L}\p{N}'’_-]+){0,4}\s*$/iu.test(before)
        && /^\s+(?:pas|jamais|plus)\b/iu.test(after);
    const directSecondPersonRequest = /(?:\b(?:could|can|would|will)\s+you|\b(?:peux|pourrais)-tu|\b(?:pouvez|pourriez)-vous)\s*$/iu.test(before);
    const informationalQuestionLead = /\bhow\s+(?:(?:do|does|did|can|could|would|should|may|might)\s+(?:i|we|you|one|they|he|she|someone)|to)\s*$/iu.test(before);
    const frenchDecisionQuestionLead = /(?:est-ce\s+que\s+)?(?:je|nous|on)\s+(?:dois|devrais|puis|pourrais|devons|devrions|pouvons|pourrions)\s*$/iu.test(before);
    const question = /\?\s*$/u.test(text.trim()) && (
      informationalQuestionLead
      || frenchDecisionQuestionLead
      || !directSecondPersonRequest && (
        /(?:\b(?:should|could|would|can)\s+[^.!?;\n]{1,120}|\b(?:when|whether)\b[^.!?;\n]{0,120}|\b(?:comment|pourquoi|quand|si|faut-il|devrait-on|peut-on|doit-on|dois-je|devrais-je|puis-je|pourrais-je|pouvons-nous|devrions-nous)\b[^.!?;\n]{0,120})\s*$/iu.test(before)
        || before.trim().length === 0
      )
    );
    const reported = /(?:\b(?:report|document|doctor|physician|clinician|polic(?:y|ies)|procedures?|protocols?)s?\b[^.!?;\n]{0,120}\b(?:says?|states?|recommends?|suggests?|mentions?|requires?|mandates?|directs?)\s*(?::|to|that)?\s*(?:(?:the\s+)?(?:admins?|administrators?|nurses?|doctors?|staff)\s+to\s+)?|\b(?:rapport|document|m[ée]decin|docteur|clinicien|politique|proc[ée]dure|protocole|r[èe]gle)s?\b[^.!?;\n]{0,120}\b(?:dit|indique|recommande|sugg[èe]re|mentionne|exige|impose|ordonne|pr[ée]voit)\s*(?::|de|d['’]|que)?\s*)$/iu.test(before);
    const governedByReportedStatement = /(?:^|[.!?;\n])\s*(?:(?:(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)|(?:(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne))\b[^.!?;\n]{0,180}$/iu.test(before);
    const documentaryHowTo = /(?:^|[.!?;\n])\s*(?:(?:(?:could|can|would)\s+you|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous)\s+)?(?:document(?:e|ez|er)|d[ée]cri(?:s|vez|re)|expliqu(?:e|ez|er)|r[ée]dig(?:e|ez|er)|write|draft|document|describe|explain)\b[^.!?;\n]{0,100}\b(?:comment|how\s+to|la\s+mani[èe]re\s+(?:de\s+|d['’]\s*)|l['’]option\s+de)\s*$/iu.test(before);
    const governedPlanningOrDesign = /(?:^|[.!?;\n])\s*(?:(?:draft|write|create|show|review|explain|r[ée]dig(?:e|ez|er)|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre|analyse|expliqu(?:e|ez|er))\b[^.!?;\n]{0,120}\b(?:plans?\s+(?:to|pour)|mockups?\s+(?:of|for)|maquettes?\s+(?:du|de\s+la|des)|boutons?\s+(?:pour|de|du)|options?\s+(?:to|de)|whether\s+(?:we\s+)?should|s['’]il\s+faut)\s*|(?:je\s+veux\s+savoir|i\s+want\s+to\s+know)\b[^.!?;\n]{0,80}\b(?:s['’]il\s+faut|whether\s+(?:we\s+)?should)\s*)$/iu.test(before);
    const governedMockupButton = /(?:^|[.!?;\n])\s*(?:show|create|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre)\b[^.!?;\n]{0,120}\b(?:mockups?|maquettes?)\b[^.!?;\n]{0,80}\b(?:buttons?|boutons?)\b/iu.test(`${before} ${after}`);
    const politeDocumentaryHowTo = /(?:^|[.!?;\n])\s*(?:please|kindly)\s+(?:document|describe|explain)\b[^.!?;\n]{0,100}\bhow\s+to\s*$/iu.test(before);
    const analyticalIndirectMutation = /(?:^|[.!?;\n])\s*(?:(?:please|kindly)\s+|merci\s+d['’]?\s*)?(?:analy[sz]e|analys(?:e|er|ez|ons)|review|explain|evaluate|assess|[ée]valu(?:e|er|ez|ons))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
    const negatedAnalyticalIndirectMutation = /(?:^|[.!?;\n])\s*(?:(?:do\s+not|don['’]t|never)\s+(?:analy[sz]e|review|explain|evaluate|assess)|(?:ne\s+|n['’]\s*)(?:analys(?:e|er|ez|ons)|revois|expliqu(?:e|er|ez|ons)|[ée]valu(?:e|er|ez|ons))\s+(?:pas|jamais))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
    const quotePairs: Array<readonly [string, string]> = [['"', '"'], ['“', '”'], ['«', '»'], ['`', '`']];
    const quoted = quotePairs.some(([open, close]) => {
      const opening = text.lastIndexOf(open, index - 1);
      if (opening < 0) return false;
      const closingBefore = text.lastIndexOf(close, index - 1);
      const closingAfter = text.indexOf(close, index + match[0].length);
      return (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
        && closingAfter >= index + match[0].length;
    });
    const action = match[0];
    const inflectedSensitiveEnglishAction = (
      ANY_ENGLISH_CLINICAL_ACTION_PATTERN.test(action)
      && !BARE_ENGLISH_CLINICAL_ACTION_PATTERN.test(action)
    ) || /^(?:(?:assign|invit|demot|disabl|enabl|activat|deactivat|suspend|includ|exclud|transfer|convert|provid|allow|authoriz|promot|grant|revok|remov|appoint|elevat|nam|add)(?:s|es|ed|d|ing)|chang(?:es|ed|ing)|den(?:ies|ied|ying)|permits|permitted|permitting|gives|giving|given|gave|makes|making|made)$/iu.test(action);
    const frenchImperativeContext = /^suspends$/iu.test(action)
      && /^\s+(?:(?:le|la|les|un|une)\s+|l['’]\s*)/iu.test(after);
    const inflectedActionRequestLead = /\b(?:start|continue|keep|begin|please|then)\s*$/iu.test(before);
    const explicitSubjectBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
    const frenchThirdPersonSensitiveAction = /^(?:attribue|assigne|ajoute|donne|accorde|octroie|r[ée]voque|retire|supprime|active|d[ée]sactive|suspend|autorise|interdit|refuse|permet|transf[èe]re|invite|r[ée]trograde|inclue|exclue|change|convertit|met|nomme|promeut|d[ée]signe|[ée]l[èe]ve|rend|adapte|ajuste|prescrit|r[ée]duit|diminue|baisse|passe|augmente|commence|initie|titre|double|divise|remplace|substitue|s[èe]vre|interrompt|reprend|red[ée]marre|renouvelle|transitionne|cesse|arr[êe]te|administre|injecte|perfuse|donne|ordonne|vaccine|immunise|inocule|intube|extube|transfuse|biopsie|pose|effectue|r[ée]alise|pratique|op[èe]re|planifie|programme|fait)$/iu.test(action)
      || /ent$/iu.test(action) && (
        DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN.test(action)
        || DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN.test(action)
        || DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN.test(action)
      );
    const englishRoleOrPronounSubject = /^(?:(?:the|a|an)\s+(?:doctor|physician|clinician|nurse|surgeon|manager|administrator|operator|technician)|(?:he|she|they))$/iu.test(explicitSubjectBefore);
    const frenchNominalOrPronounSubject = frenchThirdPersonSensitiveAction
      && /^(?:(?:le|la|l['’]|un|une|ce|cet|cette)\s+[\p{L}\p{M}'’_-]+(?:\s+[\p{L}\p{M}'’_-]+){0,2}|il|elle|ils|elles)$/iu.test(explicitSubjectBefore);
    const namedFrenchSubject = frenchThirdPersonSensitiveAction
      && /^(?!(?:Puis|Ensuite|Maintenant|Veuillez|Merci|Enfin|Alors|Please|Kindly|Then|Now)$)[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
    const namedEnglishSubject = /^(?:set|put)$/iu.test(action)
      && /^(?!(?:Please|Then|Now|Kindly)$)[A-Z][\p{L}\p{M}'’_-]+(?:\s+[A-Z][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
    const passiveSensitiveEnglishAction = /^(?:set|put)$/iu.test(action)
      && /\b(?:is|are|was|were|has\s+been|have\s+been|had\s+been)\s*$/iu.test(before);
    const passiveSensitiveFrenchAction = /\b(?:est|sont|[ée]tait|[ée]taient|a|ont|avait|avaient|sera|seront)\s+(?:[ée]t[ée]\s+)?$/iu.test(before)
      && /(?:[ée](?:e|es|s)?|u(?:e|es|s)?|it|is|t|fait)$/iu.test(action);
    const narratedExplicitSubject = englishRoleOrPronounSubject
      || frenchNominalOrPronounSubject || namedFrenchSubject || namedEnglishSubject;
    const directMedicationManagement = DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN.test(action);
    const directClinicalProcedure = DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN.test(action);
    const directPatientCare = DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN.test(action);
    const writesDocumentOnly = /^(?:write|draft|create|r[ée]dig\w*|[ée]cri\w*|cr[ée](?:e|ez|er))$/iu.test(action)
      && /^\s+(?:(?:the|a|an|le|la|les|un|une)\s+)?(?:guide|report|document|documentation|article|plan|mockup|rapport|compte\s+rendu|maquette)\b/iu.test(after);
    if (inflectedSensitiveEnglishAction && !inflectedActionRequestLead && !frenchImperativeContext) continue;
    if (family === 'clinical'
      && directMedicationManagement
      && !DIRECT_CLINICAL_LOCAL_MEDICATION_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_TRANSITION_PATTERN.test(after)
      && !DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(after)) continue;
    if (family === 'clinical'
      && directClinicalProcedure
      && !DIRECT_CLINICAL_LOCAL_PROCEDURE_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN.test(after)) continue;
    if (family === 'clinical'
      && directPatientCare
      && !DIRECT_CLINICAL_PATIENT_PROCEDURE_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN.test(after)) continue;
    if (!negated && !question && !reported && !governedByReportedStatement
      && !quoted && !documentaryHowTo && !politeDocumentaryHowTo
      && !governedPlanningOrDesign && !analyticalIndirectMutation
      && !negatedAnalyticalIndirectMutation && !governedMockupButton
      && !narratedExplicitSubject
      && !writesDocumentOnly
      && !passiveSensitiveEnglishAction && !passiveSensitiveFrenchAction) return true;
  }
  return false;
}

function hasAuthoritativeDirectClinicalMutation(text: string): boolean {
  return hasAuthoritativeMutationPattern(text, DIRECT_CLINICAL_MUTATION_ACTION_PATTERN, 'clinical');
}

function hasAuthoritativeDirectRbacMutation(text: string): boolean {
  return hasAuthoritativeMutationPattern(text, DIRECT_RBAC_MUTATION_ACTION_PATTERN);
}

function isOfficialSourceUrl(
  value: string,
  domain?: HighStakesEvidenceDomain,
  businessSourceVendors: readonly ('cerfrance' | 'silae')[] = [],
  securityDocumentationProviders: readonly SecurityDocumentationProvider[] = [],
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const businessSource = BUSINESS_DOCUMENTATION_SOURCES.get(hostname);
    return /(?:\.gov|\.gouv\.fr|\.gc\.ca|\.gov\.uk)$/.test(hostname)
      || OFFICIAL_SOURCE_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))
      || domain === 'legal' && !!businessSource
        && businessSourceVendors.includes(businessSource.vendor)
        && businessSource.path.test(url.pathname)
      || domain === 'security' && isRelevantProviderDocumentationUrl(url, securityDocumentationProviders);
  } catch { return false; }
}

/** URLs must identify the actual host; prose labels and institution names prove nothing. */
function hasOfficialSourceUrl(
  result: string,
  domain: HighStakesEvidenceDomain,
  businessSourceVendors: readonly ('cerfrance' | 'silae')[],
  securityDocumentationProviders: readonly SecurityDocumentationProvider[],
): boolean {
  return [...result.matchAll(/https?:\/\/[^\s<>"'`\\]+/gi)]
    .some(match => isOfficialSourceUrl(
      match[0].replace(/[),.;]+$/, ''), domain, businessSourceVendors, securityDocumentationProviders,
    ));
}

/** Inspect request targets, never prompt/body text that can merely mention a source. */
function targetsOfficialSource(
  toolName: string,
  input: Record<string, unknown>,
  domain: HighStakesEvidenceDomain,
  businessSourceVendors: readonly ('cerfrance' | 'silae')[],
  securityDocumentationProviders: readonly SecurityDocumentationProvider[],
): boolean {
  if (!SOURCE_INSPECTION_TOOL_PATTERN.test(toolName)) return false;
  for (const key of ['url', 'uri']) {
    if (typeof input[key] === 'string'
      && isOfficialSourceUrl(input[key], domain, businessSourceVendors, securityDocumentationProviders)) return true;
  }
  if (Array.isArray(input.open) && input.open.slice(0, 8).some(item => (
    item && typeof item === 'object' && typeof item.ref_id === 'string'
      && isOfficialSourceUrl(item.ref_id, domain, businessSourceVendors, securityDocumentationProviders)
  ))) return true;
  const command = input.command;
  if (Array.isArray(command)) return command.length === 2
    && /^(?:open|navigate|goto)$/.test(String(command[0]))
    && typeof command[1] === 'string'
    && isOfficialSourceUrl(command[1], domain, businessSourceVendors, securityDocumentationProviders);
  if (typeof command === 'string') {
    const target = command.match(/^(?:open|navigate|goto)\s+(https:\/\/[^\s"'`]+)\s*$/)?.[1];
    return !!target && isOfficialSourceUrl(target, domain, businessSourceVendors, securityDocumentationProviders);
  }
  return false;
}

export interface IndependentReviewReceipt {
  objectiveId?: string;
  acceptanceSha256?: string;
  /** Host-owned message id returned by wait_sessions for the exact completed
   * reviewer snapshot. It is never read from the reviewer's JSON prose. */
  reviewMessageId?: string;
  verdict: 'PASS' | 'FAIL';
  criteria: Array<{ id: string; passed: boolean }>;
  findings: unknown[];
}

/** Host context for a review returned by a delegated session, never inferred from its prose. */
export interface IndependentReviewContext {
  toolName: string;
  sessionIds?: readonly string[];
  objectiveId: string;
  acceptanceSha256: string;
}

const WAIT_SESSIONS_TOOL_PATTERN = /^(?:mcp__session__|session__)?wait_sessions$/;

function jsonCandidates(result: string): string[] {
  const candidates = [result.trim()];
  for (const match of result.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = result.indexOf('{');
  const lastBrace = result.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(result.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates)].filter(candidate => candidate.length <= 32_000);
}

function parseDirectReviewReceipt(result: string): IndependentReviewReceipt | undefined {
  for (const candidate of jsonCandidates(result)) {
    try {
      const value = JSON.parse(candidate) as Partial<IndependentReviewReceipt>;
      if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') continue;
      if (!Array.isArray(value.criteria) || value.criteria.length === 0 || !Array.isArray(value.findings)) continue;
      const criteria = value.criteria.filter(item => (
        !!item && typeof item.id === 'string' && typeof item.passed === 'boolean'
      ));
      if (criteria.length !== value.criteria.length) continue;
      return { verdict: value.verdict, criteria, findings: value.findings,
        ...(typeof value.objectiveId === 'string' ? { objectiveId: value.objectiveId } : {}),
        ...(typeof value.acceptanceSha256 === 'string' ? { acceptanceSha256: value.acceptanceSha256 } : {}),
      };
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

export function parseIndependentReviewReceipt(
  result: string,
  context?: IndependentReviewContext,
): IndependentReviewReceipt | undefined {
  if (!context || !WAIT_SESSIONS_TOOL_PATTERN.test(context.toolName)) return parseDirectReviewReceipt(result);
  // wait_sessions returns a host envelope, not a bare reviewer response. Only
  // consider a completed, requested session and the exact current contract.
  // Never search arbitrary nested prose or accept an unrelated/historical PASS.
  if (!context.sessionIds?.length || context.sessionIds.length > 8
    || !context.objectiveId || !context.acceptanceSha256 || result.length > 256_000) return undefined;
  try {
    const envelope = JSON.parse(result);
    if (!envelope || envelope.outcome !== 'completed' || !Array.isArray(envelope.sessions)
      || envelope.sessions.length > 8) return undefined;
    const requested = new Set(context.sessionIds);
    const seen = new Set<string>();
    const matches: IndependentReviewReceipt[] = [];
    for (const snapshot of envelope.sessions) {
      if (!snapshot || typeof snapshot.sessionId !== 'string' || !requested.has(snapshot.sessionId)) continue;
      if (seen.has(snapshot.sessionId)) return undefined;
      seen.add(snapshot.sessionId);
      if (snapshot.state !== 'idle' || snapshot.reason !== 'complete'
        || snapshot.finalTextTruncated || snapshot.needsAttention || snapshot.changed === false
        || typeof snapshot.finalText !== 'string' || snapshot.finalText.length > 32_000) continue;
      // A review example followed by a conflicting verdict is ambiguous even
      // within one session. Do not prefer the first parseable fenced receipt.
      // Only the delegated envelope uses this stricter unambiguous spelling;
      // legacy standalone review parsing remains backward compatible.
      const verdictCount = [...snapshot.finalText.matchAll(/"verdict"\s*:/g)].length;
      if (verdictCount > 1) return undefined;
      if (verdictCount !== 1) continue;
      const receipt = parseDirectReviewReceipt(snapshot.finalText);
      if (receipt?.objectiveId === context.objectiveId && receipt.acceptanceSha256 === context.acceptanceSha256) {
        const reviewMessageId = typeof snapshot.finalMessageId === 'string'
          && /^msg-[1-9]\d{0,19}-[a-z0-9]{16,64}$/.test(snapshot.finalMessageId)
          ? snapshot.finalMessageId
          : undefined;
        matches.push({ ...receipt, ...(reviewMessageId ? { reviewMessageId } : {}) });
      }
    }
    // More than one applicable verdict needs an explicit host selection; do
    // not silently prefer a PASS over another review's FAIL.
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function neutralizeExplicitOperationalTreatmentClarification(text: string): {
  text: string;
  matched: boolean;
} {
  const pattern = FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN.test(text)
    ? FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN
    : ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN.test(text)
      ? ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN
      : undefined;
  if (!pattern) return { text, matched: false };
  const matchedClarification = pattern.exec(text)?.[0];
  if (!matchedClarification) return { text, matched: false };
  const operationalClaim = matchedClarification.replace(NON_MEDICAL_CLARIFICATION_SUFFIX_PATTERN, ' ');
  if (DIRECT_MEDICAL_DOMAIN_PATTERN.test(operationalClaim)
    || CLINICAL_SIGNAL_INSIDE_CLARIFICATION_PATTERN.test(operationalClaim)
    || hasContextualMedicalTreatment(operationalClaim)) {
    return { text, matched: false };
  }
  const remainingText = text
    .replace(pattern, ' ')
    .replace(NO_MEDICAL_SOURCE_AFTER_CLARIFICATION_PATTERN, ' ');
  // A valid clarification only neutralizes its own operational statement. It
  // must never hide a separate clinical instruction that follows it.
  if (hasContextualMedicalTreatment(remainingText)) {
    return { text, matched: false };
  }
  return {
    text: remainingText,
    matched: true,
  };
}

/** Remove only the bounded clarification and its matching medical-source
 * negation. Callers must still classify every remaining instruction. */
export function stripExplicitNonMedicalOperationalTreatmentClarification(text: string): string | undefined {
  const neutralized = neutralizeExplicitOperationalTreatmentClarification(text.normalize('NFC'));
  return neutralized.matched ? neutralized.text : undefined;
}

function normalizedMedicalEvidenceText(text: string): {
  text: string;
  explicitOperationalClarification: boolean;
} {
  const operationalClarification = neutralizeExplicitOperationalTreatmentClarification(text);
  const technicalHealthText = operationalClarification.text
    .replace(TECHNICAL_HEALTH_PHRASE_PATTERN, ' ')
    .replace(TECHNICAL_LIST_HEALTH_PATTERN, '$1 ');
  return {
    text: neutralizeOperationalVerificationHealth(technicalHealthText),
    explicitOperationalClarification: operationalClarification.matched,
  };
}

function neutralizeOperationalVerificationHealth(text: string): string {
  return text.replace(
    /(?:health|sant[ée]s?)/giu,
    (health, offset: number, source: string) => {
      const before = source.slice(Math.max(0, offset - 256), offset);
      const after = source.slice(offset + health.length, offset + health.length + 96);
      const sameClauseBefore = before.split(/[.!?;\n]/u).at(-1) ?? '';
      const sameClauseAfter = after.split(/[.!?;\n]/u)[0] ?? '';
      // Product nouns such as “health records/application” and their French
      // equivalents remain medical even inside a detailed deployment request.
      if (/(?:applications?|dossiers?)\s+(?:de\s+|d[’'])$/iu.test(before)
        || /^\s+(?:applications?|records?)(?![\p{L}\p{M}\p{N}_])/iu.test(after)) {
        return health;
      }
      const boundedVerification = /(?:v[ée]rifi\w*|verif\w*|valid\w*|check\w*)\b[^.!?;\n]{0,224}$/iu.test(before);
      const operationalNeighbor = /^\s*(?:,|et|and|puis|then)\s+(?:(?:(?:la|le|les|the)\s+)|l[’'])?(?:r[ée]visions?|revisions?|statuts?|statuses?|tests?|checks?|endpoints?|https|html|interfaces?|login|dashboard)(?![\p{L}\p{M}\p{N}_])/iu.test(after);
      const standaloneOperationalQualifier = STANDALONE_OPERATIONAL_HEALTH_QUALIFIER_PATTERN.test(after);
      // `interface` and `health` are both ambiguous human-domain words. Only
      // erase the latter when the same proposition also carries a positive,
      // unmistakably software/operations anchor. A growing blacklist of
      // hospital qualifiers would otherwise keep producing false negatives.
      const hasOperationalAnchor = /\b(?:r[ée]visions?\s+(?:d[ée]ploy[ée]es?|en\s+ex[ée]cution)|deployed\s+revisions?|runtime\s+revisions?|revisions?\s+(?:at\s+runtime|in\s+production)|d[ée]ploi\w*|deploy\w*|services?|bridges?|ponts?|workers?|daemons?|repositories|repos?|conteneurs?|containers?|apis?|endpoints?|https?|auth(?:entification)?|login|monitoring|web|html)\b/iu.test(
        `${sameClauseBefore} ${sameClauseAfter}`,
      );
      // “interface” is operational only while it remains unqualified. A
      // clinical/patient/telemedicine interface is itself medical evidence and
      // must not erase the preceding health signal merely because it appears
      // in a deployment-style verification list.
      const medicallyQualifiedNeighbor = /^\s*(?:,|et|and|puis|then)[^.!?;\n]{0,96}\b(?:clinique|clinical|m[ée]dical(?:e|es|s)?|medical|patients?|soins?|care|t[ée]l[ée]m[ée]decine|telemedicine|sant[ée]|health\s+records?)\b/iu.test(after);
      return boundedVerification && (operationalNeighbor || standaloneOperationalQualifier)
        && hasOperationalAnchor
        && !medicallyQualifiedNeighbor ? ' ' : health;
    },
  );
}

/** Whether the user explicitly corrected the narrow operational meaning while
 * leaving no independent clinical signal in the same message. This predicate
 * is suitable for migrating a stale persisted medical objective; it does not
 * itself prove that the earlier objective was non-medical. */
export function isExplicitNonMedicalOperationalTreatmentClarification(text: string): boolean {
  const normalized = normalizedMedicalEvidenceText(text.normalize('NFC'));
  return normalized.explicitOperationalClarification
    && !DIRECT_MEDICAL_DOMAIN_PATTERN.test(normalized.text)
    && !hasContextualMedicalTreatment(normalized.text);
}

/** Detect the subject domain only. Mutation authority must be established by
 * the host objective classifier before this result is persisted or supplied
 * to beginObjectiveEvidenceGate. */
export function detectHighStakesEvidenceDomain(text: string): Exclude<HighStakesEvidenceDomain, 'unspecified'> | undefined {
  const normalizedText = text.normalize('NFC');
  if (isDirectLegalDocumentMutation(normalizedText)) return 'legal';
  const legalText = isOperationalTechnicalContractLifecycleObjective(normalizedText)
    ? normalizedText
      .replace(TECHNICAL_CONTRACT_PATTERN, ' ')
      .replace(OPERATIONAL_CONTRACT_LIFECYCLE_WORDS_GLOBAL_PATTERN, ' ')
    : normalizedText.replace(TECHNICAL_CONTRACT_PATTERN, ' ');
  // Neutralize only locally bounded service/check health expressions. Product
  // nouns such as health records or applications de santé remain medical even
  // when the rest of the objective has a concrete operational shape.
  const medicalText = normalizedMedicalEvidenceText(normalizedText).text;
  if (DIRECT_RBAC_DOMAIN_PATTERN.test(normalizedText)) return 'security';
  const directDomain = DOMAINS.find(([domain, pattern]) => pattern.test(
    domain === 'legal' ? legalText : domain === 'medical' ? medicalText : normalizedText,
  ))?.[0];
  return directDomain ?? (hasContextualMedicalTreatment(medicalText) ? 'medical' : undefined);
}

const CONCRETE_OPERATIONAL_SOFTWARE_TARGET_PATTERN = unicodeWordBounded(
  String.raw`services?|applications?|apps?|apis?|endpoints?|bridges?|ponts?|workers?|daemons?|conteneurs?|containers?|d[ée]ploiements?|deployments?|serveurs?|servers?|runtimes?|repositories|repos?|code|builds?|ssh|systemd|docker`,
);
const CONCRETE_OPERATIONAL_SOFTWARE_ACTION_PATTERN = unicodeWordBounded(
  String.raw`diagnosti\w*|debug\w*|corrig\w*|fix\w*|repair\w*|restaur\w*|restore\w*|d[ée]marr\w*|start\w*|red[ée]marr\w*|restart\w*|rebuild\w*|reconstru\w*|red[ée]ploi\w*|redeploy\w*|d[ée]ploi\w*|deploy\w*|r[ée]concili\w*|reconcile\w*`,
);
const CONCRETE_OPERATIONAL_SOFTWARE_VERIFICATION_PATTERN = unicodeWordBounded(
  String.raw`v[ée]rifi\w*|validate\w*|validation|tests?|preuves?|evidence|health|sant[ée]|statuts?|statuses?|r[ée]visions?|revisions?|responses?|r[ée]ponses?|successful|r[ée]uss\w*`,
);
const CONCRETE_OPERATIONAL_SOFTWARE_LOCATOR_PATTERN = /(?:^|[\s`"'(])\/(?:srv|opt|var|etc|workspace|app|apps)\/[A-Za-z0-9_@%+=:,./()\-]{2,2048}|\bhttps?:\/\/[^\s<>{}"']{3,2048}|\b(?:serveur|server|service|application|app|conteneur|container|worker|daemon|repo|repository)\s+(?:exacte?\s+)?[`"']?[A-Za-z0-9][A-Za-z0-9_.:@/\-]{2,255}/iu;

function concreteOperationalSoftwareShape(text: string): boolean {
  return text.length >= 120
    && CONCRETE_OPERATIONAL_SOFTWARE_TARGET_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_ACTION_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_VERIFICATION_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_LOCATOR_PATTERN.test(text);
}

/**
 * A fully restated, concrete software operation can safely repair an obsolete
 * persisted *domain label* when every historical human segment is also
 * non-medical under the current classifier. This predicate grants no tool or
 * target authority: it only distinguishes a detailed operational restatement
 * from a terse continuation such as “continue” or “fix it”.
 */
export function isConcreteOperationalSoftwareRestatement(text: string): boolean {
  const normalized = text.normalize('NFC').trim();
  return concreteOperationalSoftwareShape(normalized)
    && detectHighStakesEvidenceDomain(normalized) === undefined;
}

export function classifyHighStakesEvidenceDomain(text: string): HighStakesEvidenceDomain | undefined {
  const normalizedText = text.normalize('NFC');
  if (!isDirectLegalDocumentMutation(normalizedText)
    && !hasAuthoritativeMutationPattern(normalizedText, MUTATING_REQUEST_PATTERN)
    && !hasAuthoritativeDirectClinicalMutation(normalizedText)
    && !hasAuthoritativeDirectRbacMutation(normalizedText)) return undefined;
  return detectHighStakesEvidenceDomain(normalizedText);
}

/** @deprecated Pass the persisted objective authority as the fourth argument. */
export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
): ObjectiveEvidenceGateState | undefined;
export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
  authority: ObjectiveEvidenceGateAuthority,
): ObjectiveEvidenceGateState | undefined;
export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
  authority?: ObjectiveEvidenceGateAuthority,
): ObjectiveEvidenceGateState | undefined {
  // Current hosts must supply persisted authority so negated/read-only prose
  // cannot activate the gate. Preserve the published three-argument overload's
  // conservative historical behavior for consumers that have not migrated:
  // it may over-block from prose, but must never silently lose a safety gate.
  if (authority && (authority.risk !== 'high-stakes'
    || authority.evidenceRequirement !== 'authoritative-sources-before-mutation'
    || !authority.domain || authority.domain === 'unspecified')) {
    states.delete(sessionId);
    return undefined;
  }
  // When the current host supplies persisted authority, never fall back to
  // free-form prose for its domain: negated or quoted sensitive words are not
  // authority. High-risk production work without an applicable evidence
  // subject still retains its permission and independent-review guards, but
  // must not enter an impossible unspecified-source gate.
  const domain = authority
    ? authority.domain ?? 'unspecified'
    : classifyHighStakesEvidenceDomain(objectiveText);
  if (!domain) {
    states.delete(sessionId);
    return undefined;
  }
  const businessSourceVendors = objectiveBusinessSourceVendors(objectiveText);
  const securityDocumentationProviders = domain === 'security'
    ? objectiveSecurityDocumentationProviders(objectiveText) : [];
  const existing = states.get(sessionId);
  if (existing?.objectiveId === objectiveId && existing.domain === domain
    && JSON.stringify(existing.businessSourceVendors ?? []) === JSON.stringify(businessSourceVendors)
    && JSON.stringify(existing.securityDocumentationProviders ?? []) === JSON.stringify(securityDocumentationProviders)) return existing;
  const state: ObjectiveEvidenceGateState = {
    objectiveId,
    domain,
    evidenceObserved: false,
    authoritativeEvidenceObserved: false,
    independentReviewObserved: false,
    independentReviewAttempted: false,
    ...(businessSourceVendors.length ? { businessSourceVendors } : {}),
    ...(securityDocumentationProviders.length ? { securityDocumentationProviders } : {}),
  };
  states.set(sessionId, state);
  return state;
}

export function recordObjectiveEvidence(
  sessionId: string,
  toolName: string,
  result: string,
  isError: boolean,
  reviewContext?: Omit<IndependentReviewContext, 'toolName'>,
  toolInput?: Record<string, unknown>,
): void {
  const state = states.get(sessionId);
  if (!state || isError || result.trim().length < 40) return;
  if (EVIDENCE_TOOL_PATTERN.test(toolName)) {
    state.evidenceObserved = true;
    // An unknown domain cannot safely select an authoritative source class.
    // Keep the gate closed until the host restores a specific domain rather
    // than letting an unrelated official URL satisfy a generic high-risk task.
    const officialSourceObserved = sourceObservationSucceeded(result)
      && state.domain !== 'unspecified' && (toolInput === undefined
      ? SOURCE_INSPECTION_TOOL_PATTERN.test(toolName)
        && hasOfficialSourceUrl(result, state.domain, state.businessSourceVendors ?? [], state.securityDocumentationProviders ?? [])
      : targetsOfficialSource(toolName, toolInput, state.domain, state.businessSourceVendors ?? [], state.securityDocumentationProviders ?? []));
    if (officialSourceObserved || FIRST_PARTY_SOURCE_TOOLS[state.domain]?.test(toolName)) {
      state.authoritativeEvidenceObserved = true;
    }
  }
  if (REVIEW_TOOL_PATTERN.test(toolName)) {
    state.independentReviewAttempted = true;
    state.reviewInvalidatedByMutation = false;
    state.lastMutationTool = undefined;
    const receipt = parseIndependentReviewReceipt(result, reviewContext
      ? { ...reviewContext, toolName }
      : WAIT_SESSIONS_TOOL_PATTERN.test(toolName)
        ? { toolName, objectiveId: state.objectiveId, acceptanceSha256: '' }
        : undefined);
    if (receipt) {
      state.lastReviewVerdict = receipt.verdict;
      state.independentReviewObserved = receipt.verdict === 'PASS'
        && receipt.criteria.every(criterion => criterion.passed)
        && receipt.findings.length === 0;
    }
  }
}

export function isEvidenceAcquisitionTool(toolName: string): boolean {
  return EVIDENCE_TOOL_PATTERN.test(toolName) || REVIEW_TOOL_PATTERN.test(toolName);
}

export function checkObjectiveEvidenceBeforeMutation(
  sessionId: string,
  toolName: string,
  effectKind: ObjectiveEvidenceToolEffectKind = 'unknown',
): { allowed: true } | { allowed: false; reason: string } {
  const state = states.get(sessionId);
  // Delivering an internal report changes the inbox, not the reviewed target.
  // Registering immutable checks changes the host's validation contract, not
  // the reviewed deliverable. Let its strict schema/immutability validator run
  // even when source evidence is still missing. Registration cannot satisfy
  // this gate or authorize the observation tool recorded in its arguments.
  // Their own permission checks still apply; another source's send/set tool
  // remains an external mutation and must invalidate the prior review.
  if (!state || effectKind === 'read'
    || /^(?:mcp__session__|session__)?(?:send_agent_message|set_completion_criteria|update_plan|wait_sessions)$/.test(toolName)) return { allowed: true };
  const sufficientEvidence = state.evidenceObserved && state.authoritativeEvidenceObserved;
  if (!sufficientEvidence) {
    const domain = state.domain === 'unspecified' ? 'applicable high-stakes' : state.domain;
    return {
      allowed: false,
      reason: `High-stakes evidence gate: inspect a current authoritative or first-party ${domain} source before creating or materially changing the deliverable.`,
    };
  }

  // This is deliberately conservative and happens when the host authorizes the
  // mutation attempt. If a later permission boundary or runtime error prevents
  // execution, requiring a fresh review is a safe false negative; retaining a
  // stale PASS after a possibly-applied mutation would be a false positive.
  state.independentReviewObserved = false;
  state.independentReviewAttempted = false;
  state.lastReviewVerdict = undefined;
  state.reviewInvalidatedByMutation = true;
  state.lastMutationTool = toolName;
  return { allowed: true };
}

export function getObjectiveEvidenceCompletionGap(sessionId: string): string | undefined {
  const state = states.get(sessionId);
  if (!state) return undefined;
  const domain = state.domain === 'unspecified' ? 'applicable high-stakes' : state.domain;
  if (!state.evidenceObserved) return 'authoritative evidence has not been inspected';
  if (!state.authoritativeEvidenceObserved) return `no authoritative or first-party ${domain} source was verified`;
  if (!state.independentReviewObserved) {
    if (state.reviewInvalidatedByMutation) {
      return `independent review must be repeated after subsequent mutation${state.lastMutationTool ? ` (${state.lastMutationTool})` : ''}`;
    }
    return state.independentReviewAttempted
      ? `independent review did not return a structured PASS receipt${state.lastReviewVerdict === 'FAIL' ? ' (latest verdict: FAIL)' : ''}`
      : 'independent review has not been completed';
  }
  return undefined;
}

export function clearObjectiveEvidenceGate(sessionId: string): void {
  states.delete(sessionId);
}
