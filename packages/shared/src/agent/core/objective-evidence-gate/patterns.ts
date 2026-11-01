import { DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE, DIRECT_RBAC_MUTATION_ACTION_SOURCE, DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE } from "../rbac-action-grammar.ts";
import type { HighStakesEvidenceDomain } from './contracts.ts';

export const MUTATING_REQUEST_PATTERN = /\b(?:create|draft|write(?!\s+(?:access|privileges?|rights?|roles?)\b)|rewrite|update|replace|change|modify|amend|cancel|void|rescind|correct|implement|apply|publish|submit|deploy|delete|remove|sign|countersign|approve|accept|archive|generate|execute|send|upload|transfer|terminate|renew|cr[ée](?:e|er)|r[ée]dig\w*|r[ée][ée]cri\w*|[ée]cri\w*|fais\s+[ée]voluer|m(?:ets?|ettez)\s+[aà]\s+jour|remplac\w*|modifi\w*|amend\w*|annul\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|publi\w*|soumet\w*|d[ée]ploi\w*|supprim\w*|sign\w*|contresign\w*|approuv\w*|accept\w*|archiv\w*|g[ée]n[éeè]r\w*|ex[ée]cut\w*|envo\w*|t[ée]l[ée]vers\w*|transf[éeè]r\w*|r[ée]sili\w*|renouvel\w*)\b/i;

export const DIRECT_RBAC_DOMAIN_PATTERN = unicodeWordBounded(
  String.raw`${DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE}|${DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE}`,
);

export const DIRECT_RBAC_MUTATION_ACTION_PATTERN = new RegExp(
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  'giu',
);

/** JavaScript's \b is ASCII-only, so it has no boundary after words such as "sécurité". */
function unicodeWordBounded(source: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`, 'iu');
}

export const DIRECT_MEDICAL_DOMAIN_PATTERN = unicodeWordBounded(String.raw`medical|m[ée]dic(?:al|aux|ale|ales)|sant[ée]s?|patients?|hospitals?|healthcare|clinical|therapeutic|pharmac(?:y|ies)|diagnostics?\s+m[ée]dic(?:al|aux|ale|ales)|health\s+(?:applications?|records?)`);

export const DOMAINS: Array<[Exclude<HighStakesEvidenceDomain, 'unspecified'>, RegExp]> = [
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
export const TECHNICAL_CONTRACT_PATTERN = /\b(?:(?:contrats?|contracts?)\s+(?:(?:de\s+|d[’'])(?:compl[ée]tion|validation\s+automatique|sortie(?:\s+JSON)?|preuve\s+automatique|(?:l[’']|une?\s+)?API|(?:l[’'])?interface|service\s+API)|API|OpenAPI|Solidity|JSON|IPC|SDK|ABI|technique|h[oô]te|tests?(?:\s+results?)?|schemas?|fixtures?|interfaces?|definitions?|mocks?|records?|rows?|to\s+Ethereum)|(?:completion|API|OpenAPI|JSON|IPC|SDK|software|interface|output|tool)\s+contracts?|(?:smart|Solidity|Ethereum|blockchain)[- ]contracts?|(?:commandes?\s+)?(?:Bash|shell|SSH)\s+(?:du|de\s+(?:ce|notre))\s+contrat(?:\s+(?:courant|actif))?)\b/gi;

export const OPERATIONAL_CONTRACT_LIFECYCLE_SUBJECT_PATTERN = unicodeWordBounded(String.raw`e[- ]?doc|apis?|ssh|serveurs?|servers?|runtimes?|bases?\s+de\s+donn[ée]es?|databases?|db|sql|postgres(?:ql)?|files?|queues?|workers?|webhooks?|callbacks?|mappings?|synchronisations?|synchronizations?|logs?|journaux|buckets?|stockages?|storages?|conteneurs?|containers?|code\s+source|source\s+code|modules?|services?`);

export const OPERATIONAL_CONTRACT_LIFECYCLE_ACTION_PATTERN = unicodeWordBounded(String.raw`diagnosti\w*|debug\w*|r[ée]concili\w*|synchronis\w*|inspect\w*|analys\w*|v[ée]rifi\w*|check\w*|corrig\w*|fix\w*|mapping|statuts?|statuses?|failed|erreurs?|errors?|incidents?|files?|queues?|callbacks?|webhooks?`);

export const OPERATIONAL_CONTRACT_LIFECYCLE_WORD_PATTERN = unicodeWordBounded(String.raw`contrats?|contracts?|signatures?|sign[ée](?:e|es|s)?|signed|e[- ]?doc`);

export const OPERATIONAL_CONTRACT_LIFECYCLE_WORDS_GLOBAL_PATTERN = /(?:^|[^\p{L}\p{M}\p{N}_])(?:contrats?|contracts?|signatures?|sign[ée](?:e|es|s)?|signed|e[- ]?doc)(?![\p{L}\p{M}\p{N}_])/giu;

export const GENUINE_LEGAL_DELIVERABLE_PATTERN = unicodeWordBounded(String.raw`juridiques?|legal|law|droits?\s+applicables?|applicable\s+law|ndas?|non[- ]disclosure|clauses?|conditions?\s+(?:contractuelles?|g[ée]n[ée]rales)|contractual\s+(?:terms?|clauses?)|compliance|conformit[ée]s?|notari\w*|r[ée]dig\w*\s+(?:un\s+)?contrat|draft\w*\s+(?:a\s+)?contract`);

const DIRECT_LEGAL_DETERMINER_SOURCE = String.raw`(?:(?:(?:le|la|les|ce|cet|cette|un|une|des|du|tous?|toutes?|nos|notre|mes|mon|ma|vos|votre|leurs?|the|a|an|this|that|all(?:\s+of)?|both|our|my|your|their|customer|client|employment|[\p{L}\p{M}][\p{L}\p{M}'’_-]{0,40}['’]s)\s+|l[’']\s*)){0,3}`;

const DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}(?:contrats?|(?:PNS\s+)?contracts?|accords?|agreements?)(?![\p{L}\p{M}\p{N}_])`;

const DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}(?:(?:documents?\s+(?:juridiques?|l[ée]g(?:al|aux|ale|ales)|ndas?|non[- ]disclosure))|(?:(?:juridiques?|l[ée]g(?:al|aux|ale|ales)|ndas?|non[- ]disclosure)\s+documents?))(?![\p{L}\p{M}\p{N}_])`;

const DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE = String.raw`${DIRECT_LEGAL_DETERMINER_SOURCE}documents?(?![\p{L}\p{M}\p{N}_])`;

export const DIRECT_CONTRACT_OR_AGREEMENT_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}(?![ \t]+(?:statuts?|statuses?|ids?|identifiants?|records?|enregistrements?|fields?|champs?|rows?|lignes?|mappings?|synchronisations?|synchronizations?)\b)`,
  'iu',
);

export const DIRECT_QUALIFIED_LEGAL_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE}`,
  'iu',
);

export const DIRECT_COMMITTING_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`\b(?:sign|countersign|approve|accept|sign\w*|contresign\w*|approuv\w*|accept\w*)\b\s+${DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE}\b`,
  'iu',
);

export const DIRECT_TARGET_FIRST_LEGAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}|${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE})[^.!?;\n]{0,72}(?:,|:|[\u2013\u2014])\s*(?:${MUTATING_REQUEST_PATTERN.source})`,
  'iu',
);

export const DIRECT_REFERENTIAL_LEGAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${MUTATING_REQUEST_PATTERN.source})\s+(?:it|them|cela|ceci|[cç]a|le|la|les)\s+(?:from|in|inside|of|dans|depuis|du|de\s+la|des)\s+${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}`,
  'iu',
);

export const DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_MUTATION_PATTERN = new RegExp(
  String.raw`${DIRECT_GENERIC_DOCUMENT_TARGET_SOURCE}[^.!?;\n]{0,72},\s*\b(?:sign|countersign|approve|accept|sign\w*|contresign\w*|approuv\w*|accept\w*)\b`,
  'iu',
);

const ENGLISH_LEGAL_PASSIVE_ACTION_SOURCE = String.raw`(?:created|drafted|written|rewritten|updated|replaced|changed|modified|amended|cancell?ed|voided|rescinded|published|submitted|deleted|removed|signed|countersigned|approved|accepted|archived|generated|executed|sent|uploaded|transferred|terminated|renewed)`;

const FRENCH_LEGAL_PASSIVE_ACTION_SOURCE = String.raw`(?:cr[ée][ée]s?|r[ée]dig[ée]s?|[ée]crits?|r[ée][ée]crits?|mis(?:e|es)?\s+[aà]\s+jour|remplac[ée]s?|chang[ée]s?|modifi[ée]s?|amend[ée]s?|annul[ée]s?|publi[ée]s?|soumis(?:e|es)?|supprim[ée]s?|sign[ée]s?|contresign[ée]s?|approuv[ée]s?|accept[ée]s?|archiv[ée]s?|g[ée]n[ée]r[ée]s?|ex[ée]cut[ée]s?|envoy[ée]s?|t[ée]l[ée]vers[ée]s?|transf[ée]r[ée]s?|r[ée]sili[ée]s?|renouvel[ée]s?)`;

export const DIRECT_TARGET_FIRST_LEGAL_PASSIVE_MUTATION_PATTERN = new RegExp(
  String.raw`(?:${DIRECT_CONTRACT_OR_AGREEMENT_TARGET_SOURCE}|${DIRECT_QUALIFIED_LEGAL_DOCUMENT_TARGET_SOURCE})[^.!?;\n]{0,72}\b(?:(?:must|needs?\s+to|has\s+to|is\s+to|should)\s+be\s+${ENGLISH_LEGAL_PASSIVE_ACTION_SOURCE}|(?:doit|doivent|devra|devront)\s+(?:[êe]tre\s+)?${FRENCH_LEGAL_PASSIVE_ACTION_SOURCE})(?![\p{L}\p{M}\p{N}_])`,
  'iu',
);

export const DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_PASSIVE_PATTERN = new RegExp(
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

export const UNIVERSALLY_NEGATED_LEGAL_EFFECT_PATTERN = new RegExp(
  String.raw`(?:^|[.!?;\n]\s*|\s+et\s+|\s+and\s+)(?:aucun(?:e|es|s)?|no)\s+(?:(?:nouvel(?:le|les|s)?|autres?|new|additional|further|second(?:e|es|s)?)\s+)?${NEGATED_LEGAL_EFFECT_SUBJECT_SOURCE}(?:${NEGATED_LEGAL_EFFECT_LIST_SEPARATOR_SOURCE}(?:(?:nouvel(?:le|les|s)?|autres?|new|additional|further|second(?:e|es|s)?)\s+)?${NEGATED_LEGAL_EFFECT_SUBJECT_SOURCE}){0,5}\s+(?:(?:ne|n['’])\s+)?(?:doit|doivent|devra|devront|must|should|shall|will)\s+(?:pas\s+|not\s+|never\s+)?(?:[êe]tre\s+|be\s+)?(?:r[ée][ée]mis(?:e|es)?|r[ée]envoy[ée]s?|envoy[ée]s?|[ée]mis(?:e|es)?|cr[ée][ée]s?|sign[ée]s?|contresign[ée]s?|approuv[ée]s?|accept[ée]s?|supprim[ée]s?|sent|reissued|issued|created|signed|countersigned|approved|accepted|deleted|removed)(?![\p{L}\p{M}\p{N}_])`,
  'giu',
);

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

export const TECHNICAL_HEALTH_PHRASE_PATTERN = new RegExp(
  String.raw`${UNICODE_WORD_START}(?:sant[ée]s?\s+${TECHNICAL_HEALTH_TARGET_LINK}|(?:sondes?|routes?|endpoints?)\s+(?:de\s+|d[’'])?sant[ée]s?(?:\s+${TECHNICAL_HEALTH_TARGET_LINK})?|(?:contr[oô]les?|v[ée]rifications?|[ée]tats?|statuts?)\s+(?:de\s+|d[’'])?sant[ée]s?\s+${TECHNICAL_HEALTH_TARGET_LINK})${UNICODE_WORD_END}${TECHNICAL_HEALTH_QUALIFIER}${TECHNICAL_HEALTH_PHRASE_END}`,
  'giu',
);

export const TECHNICAL_LIST_HEALTH_PATTERN = new RegExp(
  String.raw`(${UNICODE_WORD_START}(?:https?|login|dashboard|endpoints?|sites?)\b[^.!?\n]{0,64}\b(?:et|puis)\s+(?:la\s+)?)sant[ée]s?${UNICODE_WORD_END}${TECHNICAL_HEALTH_PHRASE_END}`,
  'giu',
);

export const STANDALONE_OPERATIONAL_HEALTH_QUALIFIER_PATTERN = new RegExp(
  String.raw`^\s+${TECHNICAL_HEALTH_QUALIFIER_SOURCE}(?=\s*(?:$|[.!?;]|(?:et|puis|apr[eè]s|avant|pour|and|then|after|before)\b|[,:]))`,
  'iu',
);

// A persisted legacy contract can have mistaken the operational noun
// “traitement” for medical work. Admit only an explicit, locally bound
// correction that both names an operational meaning and negates the medical
// meaning. Merely saying “not medical” is deliberately insufficient.
export const FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN = /(?:le\s+terme\s+)?[«“"'’]?\s*traitements?\s*[»”"'’]?\s+(?:d[ée]signe|signifie|concerne|correspond\s+(?:ici\s+)?[àa])\s+(?:ici\s+)?(?:une?\s+)?(?:op[ée]ration\s+(?:d['’]\s*)?)?(?:int[ée]gration|imports?|synchronisation|traitement\s+(?:de|des)\s+donn[ée]es|processus|workflows?|pipelines?|apis?|connecteurs?|logiciels?)(?:\s+(?:isagri|apis?|plc|sharepoint|donn[ée]es?|data|connecteurs?|logiciels?|techniques?)){0,4}(?:,\s*|\s+et\s+)(?:mais\s+)?(?:pas|non)(?:\s+(?:[àa]|comme))?(?:\s+(?:un|une|du|de\s+la))?(?:\s+(?:acte|soin|traitement|domaine|cas|sujet|op[ée]ration))?\s+m[ée]dic(?:al|ale|aux|ales)/iu;

export const ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN = /(?:the\s+term\s+)?[“"']?\s*treatments?\s*[”"']?\s+(?:means|refers?\s+to|denotes|concerns|is)\s+(?:an?\s+)?(?:operation\s+of\s+)?(?:integration|imports?|synchronization|data\s+processing|process|workflows?|pipelines?|apis?|connectors?|software)(?:\s+(?:isagri|apis?|plc|sharepoint|data|connectors?|software|technical)){0,4}(?:,\s*|\s+and\s+)(?:but\s+)?not(?:\s+an?)?\s+medical(?:\s+(?:act|treatment|domain|case|procedure|operation))?/iu;

export const NO_MEDICAL_SOURCE_AFTER_CLARIFICATION_PATTERN = /(?:ne\s+(?:me\s+|nous\s+)?(?:re)?demand\w*\s+(?:donc\s+)?(?:plus\s+)?(?:pas\s+(?:de|des)|aucune?s?)\s+sources?\s+m[ée]dicales?|(?:do\s+not|don't|no\s+need\s+to)\s+(?:ask\s+(?:again\s+)?for|request)\s+(?:any\s+)?medical\s+sources?)/iu;

export const NON_MEDICAL_CLARIFICATION_SUFFIX_PATTERN = /(?:(?:,\s*|\s+et\s+)(?:mais\s+)?(?:pas|non)(?:\s+(?:[àa]|comme))?(?:\s+(?:un|une|du|de\s+la))?(?:\s+(?:acte|soin|traitement|domaine|cas|sujet|op[ée]ration))?\s+m[ée]dic(?:al|ale|aux|ales)|(?:,\s*|\s+and\s+)(?:but\s+)?not(?:\s+an?)?\s+medical(?:\s+(?:act|treatment|domain|case|procedure|operation))?)$/iu;

export const CLINICAL_SIGNAL_INSIDE_CLARIFICATION_PATTERN = unicodeWordBounded(String.raw`patients?|vih|hiv|sida|aids|soins?|care|m[ée]decins?|doctors?|diagnostics?|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|antibiotiques?|antibiotics?|insulines?|insulins?|m[ée]dicaments?|medications?`);

const MEDICAL_TREATMENT_SOURCE = String.raw`(?:traitements?|treatments?)`;

export const MEDICAL_TREATMENT_PATTERN = new RegExp(String.raw`\b${MEDICAL_TREATMENT_SOURCE}\b`, 'i');

export const MEDICAL_TREATMENT_OCCURRENCE_PATTERN = new RegExp(String.raw`\b${MEDICAL_TREATMENT_SOURCE}\b`, 'gi');

// “Traitement/treatment” is ambiguous on its own. Treat it as medical only
// inside the same clause as an unambiguous clinical subject or management
// phrase. Context is folded to ASCII so accented and decomposed French input
// follow the same path.
export const CLINICAL_CONDITION_PATTERN = new RegExp(String.raw`\b(?:${[
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

export const CLINICAL_TREATMENT_QUALIFIER_PATTERN = new RegExp(String.raw`\b(?:${[
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

export const DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE})$`, 'iu');

export const DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE})$`, 'iu');

export const DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN = new RegExp(`^(?:${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu');

export const BARE_ENGLISH_CLINICAL_ACTION_PATTERN = /^(?:adjust|change|modify|prescribe|reduce|lower|increase|decrease|raise|start|begin|initiate|commence|switch|stop|hold|withhold|suspend|cease|resume|restart|renew|double|halve|(?:up|down)?titrate|transition|replace|substitute|convert|taper|wean|escalate|de[- ]escalate|put|medicate|dose|administer|inject|infuse|give|order|discontinue|set|perform|conduct|operate|schedule|carry\s+out|do|undertake|intubate|extubate|transfuse|biopsy|vaccinate|immunize|inoculate)$/iu;

export const ANY_ENGLISH_CLINICAL_ACTION_PATTERN = new RegExp(`^(?:${ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE}|${ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE}|${ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu');

export const DIRECT_CLINICAL_MANAGEMENT_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|the|a|an)\s+|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?${DIRECT_CLINICAL_TARGET_SOURCE}(?:\s+(?:therap(?:y|ies)|traitements?|th[ée]rapies?|prescriptions?|ordonnances?|dosages?|doses?|posologies?))?(?![\p{L}\p{N}_])`,
  'iu',
);

// Medication names are open-ended and should not be maintained as a brittle
// allowlist. A direct instruction to change a dose/posology is clinical unless
// its object is an explicitly operational batch/data target.
export const DIRECT_CLINICAL_DOSAGE_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:la|le|les|une?|the|an?)\s+)?(?:(?:doses?|dosages?|posologies?)\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)(?!(?:traitements?|treatments?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*|(?!(?:la|le|les|une?|the|an?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:doses?|dosages?|posologies?))`,
  'iu',
);

export const DIRECT_CLINICAL_PRESCRIPTION_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:la|le|les|une?|the|an?)\s+|l['’]\s*)?(?:prescriptions?|ordonnances?)\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${DIRECT_CLINICAL_MEDICATION_SOURCE}(?![\p{L}\p{N}_])`,
  'iu',
);

export const DIRECT_CLINICAL_PRESCRIPTION_PATTERN = new RegExp(
  String.raw`\b(?:prescri(?:s|t|re|vez|vons)|prescribe(?:s|d|ing)?)\s+(?!(?:(?:du|de\s+la|des|le|la|les|l['’]|une?|the|an?)\s+)?(?:traitements?|treatments?|lots?|batch(?:es)?|pipelines?|apis?|data|donnees?|requests?|requetes?|files?|fichiers?|inventor(?:y|ies)|stocks?|candidatures?|applications?|customers?|clients?)\b)(?:(?:du|de\s+la|des|le|la|les|l['’]|une?|the|an?)\s+)?[\p{L}\p{M}][\p{L}\p{M}'’_-]*`,
  'iu',
);

// Likewise, recognize broad surgical-procedure morphology rather than naming
// individual operations such as appendectomy.
const DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE = String.raw`(?:[\p{L}\p{M}'’_-]{3,}(?:ectomie|ectomy|otomie|otomy|plastie|plasty|scopie|scopy|stomie|stomy)|biopsie|biopsy|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|perfusions?|infusions?|intubations?|${CLINICAL_TREATMENT_MODALITY_SOURCE})`;

export const DIRECT_CLINICAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);

export const DIRECT_CLINICAL_MUTATION_ACTION_PATTERN = new RegExp(
  String.raw`\b(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}|${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}|${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})\b`,
  'giu',
);

export const DIRECT_CLINICAL_PATIENT_MEDICATION_MANAGEMENT_PATTERN = new RegExp(
  String.raw`\b(?:switch(?:es|ed|ing)?|transition(?:s|ed|ing)?|convert(?:s|ed|ing)?|wean(?:s|ed|ing)?|put(?:s|ting)?|pass(?:er|e(?:s|z)?|ons?|ent)|transitionn(?:er|e(?:s|z)?|ons?|ent)|convert(?:ir|is|it|issez|issons|issent)|s[èe]vr(?:er|e(?:s|z)?|ons?|ent)|mettre|mets?|mettez|mettons|mettent)(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}\b${DIRECT_CLINICAL_MEDICATION_SOURCE}\b)[^.!?;\n]{1,120}`,
  'iu',
);

export const DIRECT_CLINICAL_PATIENT_CARE_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE}(?![\p{L}\p{N}_])\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|un|une|the|a)\s+)?patients?\b`,
  'iu',
);

export const DIRECT_CLINICAL_MEDICATION_TRANSITION_PATTERN = new RegExp(
  String.raw`\b${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);

export const DIRECT_CLINICAL_NAMED_PERSON_ACTION_PATTERN = new RegExp(
  String.raw`(?:^|[.!?;\n]\s*)(?:[Vv]accinat(?:e|es|ed|ing)|[Vv]accin(?:er|e(?:s|z)?|ons?|ent)|[Ii]mmuniz(?:e|es|ed|ing)|[Ii]mmunis(?:er|e(?:s|z)?|ons?|ent)|[Ii]noculat(?:e|es|ed|ing)|[Ii]nocul(?:er|e(?:s|z)?|ons?|ent)|[Ee]xtubat(?:e|es|ed|ing)|[Ee]xtub(?:er|e(?:s|z)?|ons?|ent)|[Tt]ransfus(?:e|es|ed|ing|er|e(?:s|z)?|ons?|ent))\s+${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);

export const DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}(?:\b\d+(?:[.,]\d+)?\s*(?:mcg|mg|g|ml|iu|units?|unit[ée]s?)\b|\b${DIRECT_CLINICAL_MEDICATION_SOURCE}\b))[^.!?;\n]{1,120}`,
  'iu',
);

export const DIRECT_CLINICAL_LOCAL_MEDICATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?(?:(?:${DIRECT_CLINICAL_TARGET_SOURCE})(?:\s+(?:therap(?:y|ies)|traitements?|th[ée]rapies?|prescriptions?|ordonnances?|dosages?|doses?|posologies?))?|(?:traitements?|treatments?|therap(?:y|ies)|th[ée]rapies?)|(?!(?:lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|requests?|requ[êe]tes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)|(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)(?:\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${DIRECT_CLINICAL_MEDICATION_SOURCE})?)(?![\p{L}\p{N}_])`,
  'iu',
);

export const DIRECT_CLINICAL_LOCAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${DIRECT_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);

export const DIRECT_CLINICAL_PATIENT_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b`,
  'iu',
);

export const DIRECT_CLINICAL_LOCAL_TRANSITION_PATTERN = new RegExp(
  String.raw`^${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);

export const DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:the|a|le|la|un|une)\s+)?${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);

export const CLINICAL_TREATMENT_MODALITY_PATTERN = new RegExp(
  String.raw`\b(?:traitements?\s+(?:(?:par|de|avec)\s+)?${CLINICAL_TREATMENT_MODALITY_SOURCE}|${CLINICAL_TREATMENT_MODALITY_SOURCE}\s+traitements?|treatments?\s+(?:(?:by|with|using|of)\s+)?${CLINICAL_TREATMENT_MODALITY_SOURCE}|${CLINICAL_TREATMENT_MODALITY_SOURCE}\s+treatments?)\b`,
  'i',
);

export const CLINICAL_TREATMENT_PRESCRIPTION_PATTERN = /\b(?:prescri(?:s|t|re|vez|vons|ption|ptions|be|bed|bing)|ordonnances?)\b/i;

export const CLINICAL_TREATMENT_DOSAGE_PATTERN = new RegExp(
  String.raw`\b(?:(?:dosages?|doses?|posologies?)\s+(?:(?:du|de\s+la|des|de\s+(?:ce|cette)|dudit|of\s+(?:the|this))\s+)?${MEDICAL_TREATMENT_SOURCE}|${MEDICAL_TREATMENT_SOURCE}(?:\s+plans?)?\s+(?:dosages?|doses?|posologies?))\b`,
  'i',
);

export const EXPLICIT_TREATMENT_SUBJECT_TAIL_PATTERN = /^\s+(?:du|des|de\s+la|de\s+l['’]|pour(?:\s+(?:le|la|les)|\s+l['’])?|of(?:\s+the)?|for(?:\s+the)?)\s+[^,.!?;\n]{1,96}/i;

export const CONCRETE_OPERATIONAL_SOFTWARE_TARGET_PATTERN = unicodeWordBounded(
  String.raw`services?|applications?|apps?|apis?|endpoints?|bridges?|ponts?|workers?|daemons?|conteneurs?|containers?|d[ée]ploiements?|deployments?|serveurs?|servers?|runtimes?|repositories|repos?|code|builds?|ssh|systemd|docker`,
);

export const CONCRETE_OPERATIONAL_SOFTWARE_ACTION_PATTERN = unicodeWordBounded(
  String.raw`diagnosti\w*|debug\w*|corrig\w*|fix\w*|repair\w*|restaur\w*|restore\w*|d[ée]marr\w*|start\w*|red[ée]marr\w*|restart\w*|rebuild\w*|reconstru\w*|red[ée]ploi\w*|redeploy\w*|d[ée]ploi\w*|deploy\w*|r[ée]concili\w*|reconcile\w*`,
);

export const CONCRETE_OPERATIONAL_SOFTWARE_VERIFICATION_PATTERN = unicodeWordBounded(
  String.raw`v[ée]rifi\w*|validate\w*|validation|tests?|preuves?|evidence|health|sant[ée]|statuts?|statuses?|r[ée]visions?|revisions?|responses?|r[ée]ponses?|successful|r[ée]uss\w*`,
);

export const CONCRETE_OPERATIONAL_SOFTWARE_LOCATOR_PATTERN = /(?:^|[\s`"'(])\/(?:srv|opt|var|etc|workspace|app|apps)\/[A-Za-z0-9_@%+=:,./()\-]{2,2048}|\bhttps?:\/\/[^\s<>{}"']{3,2048}|\b(?:serveur|server|service|application|app|conteneur|container|worker|daemon|repo|repository)\s+(?:exacte?\s+)?[`"']?[A-Za-z0-9][A-Za-z0-9_.:@/\-]{2,255}/iu;
