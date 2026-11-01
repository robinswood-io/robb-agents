import { DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE, DIRECT_CLINICAL_MODIFIER_SOURCE, DIRECT_CLINICAL_NAMED_PERSON_SOURCE, DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE, DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE, DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE, ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE, ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE, ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE } from "../../agent/core/objective-evidence-gate.ts";
import { DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE, DIRECT_RBAC_MUTATION_ACTION_SOURCE, DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE } from "../../agent/core/rbac-action-grammar.ts";

export const SENSITIVE_DOMAIN_PATTERN = /\b(?:secrets?|credentials?|passwords?|api key|api access|(?:api|customer|client|user) accounts?|accounts? (?:for )?(?:api|customers?|clients?|users?)|access token|oauth tokens?|tokens? oauth|payments?|invoices?|accounting|ledger|reconciliation|bank|financial|tax(?:es|ation)?|fiscal|legal|security|permissions?|rbac|acls?|access control lists?|(?:admin(?:istrator)?s? (?:roles?|groups?)|(?:roles?|groups?) (?:(?:of|for) )?admin(?:istrator)?s?)|promot(?:e|es|ed|ing) [^.!?;\n]{1,80} to (?:an? )?admin(?:istrator)|signature|notari[sz](?:e|ation)?|transaction|nda|non-disclosure|pii|personally identifiable information|personal data|customer (?:data|records?)|user records?|production (?:database|db|server))\b|(?:\bsecrets?\b|mot(?:s)? de passe|identifiant|\bacc[èe]s\s+api\b|\bcomptes?\s+(?:(?:de|du|des|pour)\s+(?:l['’]\s*)?)?(?:api|clients?|utilisateurs?)\b|jeton d['’]accès|(?:jetons?|tokens?) oauth|cl[ée] api|paiement|factur|comptab|bancaire|financier|fiscal|imp[oô]t|jurid|s[ée]curit|permission|rbac|acls?|r[oô]les?\s+(?:(?:de|des|pour\s+les?)\s+|d['’]\s*)?administrateurs?|groupes?\s+(?:(?:de|des|pour\s+les?)\s+|d['’]\s*)?administrateurs?|signature|notari|transaction|donn[ée]es? personnelles?|donn[ée]es? clients?|dossiers? clients?|base de donn[ée]es? de production|serveur de production)/i;

export const DIRECT_RBAC_DOMAIN_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE}|${DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE})(?![\p{L}\p{N}_])`,
  'iu',
);

export const CRITICAL_DOMAIN_PATTERN = /\b(?:secrets?|credentials?|passwords?|api keys?|api access|(?:api|customer|client|user) accounts?|accounts? (?:for )?(?:api|customers?|clients?|users?)|access tokens?|oauth tokens?|tokens? oauth|payments?|bank|transaction|pii|personally identifiable information|production (?:database|db|server)|customer (?:data|records?)|user records?|personal data)\b|\b(?:secrets?|mot(?:s)? de passe|identifiants?|acc[èe]s\s+api|comptes?\s+(?:(?:de|du|des|pour)\s+(?:l['’]\s*)?)?(?:api|clients?|utilisateurs?)|jetons? d['’]accès|(?:jetons?|tokens?) oauth|cl[ée]s? api|paiements?|bancaire|transaction|base de donn[ée]es? de production|serveur de production|donn[ée]es? clients?|dossiers? clients?|donn[ée]es? personnelles?)\b/i;

export const NON_CREDENTIAL_OBSERVATION_IDENTIFIER_PATTERN = /(?<![\p{L}\p{N}_])identifiants?\s+d['’]\s*observations?(?![\p{L}\p{N}_])/giu;

export const SENSITIVE_OBSERVATION_IDENTIFIER_QUALIFIER_PATTERN = /(?:\bidentifiants?\s+d['’]\s*observations?\b[^.!?;\n]{0,80}\b(?:compte|account|api|production|prod|authentification|authentication|connexion|login|secret|credentials?)\b|\b(?:compte|account|api|production|prod|authentification|authentication|connexion|login|secret|credentials?)\b[^.!?;\n]{0,80}\bidentifiants?\s+d['’]\s*observations?\b)/iu;

export const PRODUCTION_ENVIRONMENT_RISK_PATTERN = /(?:\b(?:production|prod)\b.{0,80}\b(?:environment|server|database|db|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|erase|wipe|clean|purge|drop|restart|execute|write|apply|fix|change|modify)\b|\b(?:environment|server|database|db|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|erase|wipe|clean|purge|drop|restart|execute|write|apply|fix|change|modify)\b.{0,80}\b(?:production|prod)\b|\bproduction\b.{0,80}\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|d[ée]plo(?:i|y)|publie|migration|restaure|supprim|effa|nettoi|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*|\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|d[ée]plo(?:i|y)|publie|migration|restaure|supprim|effa|nettoi|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*.{0,80}\bproduction\b)/i;

export const FRENCH_PRODUCTION_PROMOTION_PATTERN = /(?<![\p{L}\p{N}_])(?:mettre|mets?|mettez|mettons)(?:\s+[\p{L}\p{N}'’_-]+){0,8}\s+en\s+production(?![\p{L}\p{N}_])/iu;

export const EXPLICIT_READ_ONLY_PATTERN = /\b(read[ -]?only|audit only|inspect only|verify only|no writes?|without (?:any )?(?:change|mutation|write))\b|\b(lecture seule|sans (?:aucune )?(?:modification|mutation|écriture)|aucune (?:modification|mutation|écriture)|vérifie seulement|contrôle seulement)/i;

const ENGLISH_SENSITIVE_TRANSFER_SOURCE = '(?:(?:transfer|send|export|commit|share|email(?:s|ed|ing)?|mail(?:s|ed|ing)?|attach(?:es|ed|ing)?|post(?:s|ed|ing)?|cop(?:y|ies|ied|ying)|forward(?:s|ed|ing)?|inform(?:s|ed|ing)?|notif(?:y|ies|ied|ying))(?:(?:\\s+(?!(?:and|then|but)\\b)[\\p{L}\\p{N}\'’_-]+){0,5})\\s+(?:money|funds?|payments?|customer\\s+(?:data|records?)|user\\s+records?|personal\\s+data|credentials?|passwords?|api\\s+keys?|access\\s+tokens?))';

const STRUCTURED_SOURCE_TRANSFER_VERB_SOURCE = String.raw`(?:export(?:s|ed|ing)?|shar(?:e|es|ed|ing)|send(?:s|ing)?|sent|email(?:s|ed|ing)?|mail(?:s|ed|ing)?|attach(?:es|ed|ing)?|post(?:s|ed|ing)?|forward(?:s|ed|ing)?|cop(?:y|ies|ied|ying)|export(?:er|e(?:z)?|ons?)|partag(?:er|e(?:z)?|ons?)|envo(?:yer|ie(?:s)?|yez|yons)|adress(?:er|e(?:s|z)?|ons?)|attach(?:er|e(?:s|z)?|ons?)|(?:joindre|joins?|joignez|joignons|joint)|transmet(?:tre|s?|tez|tons)|copi(?:er|e(?:s|z)?|ons|é(?:e|es|s)?))`;

const STRUCTURED_SOURCE_TRANSFER_TARGET_SOURCE = String.raw`(?:selected\s+(?:spreadsheet\s+)?rows?|spreadsheet|workbook|worksheet|data\s*set|rows?|records?|tableur|classeur|feuille\s+de\s+calcul|lignes?\s+s[ée]lectionn[ée]es?|enregistrements?|jeu\s+de\s+donn[ée]es)`;

export const STRUCTURED_SOURCE_TRANSFER_PATTERN = new RegExp(
  // With a host-marked confidential/restricted source, the structured target
  // itself supplies the missing domain signal. A destination preposition is not
  // required: English double-object forms ("send Alice the rows") and terse
  // commands ("export the spreadsheet") are still real data movement.
  `(?<![\\p{L}\\p{N}_])${STRUCTURED_SOURCE_TRANSFER_VERB_SOURCE}(?=[^.!?;\\n]{0,160}(?<![\\p{L}\\p{N}_])${STRUCTURED_SOURCE_TRANSFER_TARGET_SOURCE}(?![\\p{L}\\p{N}_]))`,
  'giu',
);

const ENGLISH_MUTATION_VERB_SOURCE = `(?:deploy|release|publish|delete|remove|purge|drop|migrate|rollback|restart|stop|rotate|revoke|grant|authorize|promot(?:e|es|ed|ing)|write(?!\\s+(?:access|privileges?|rights?|roles?)\\b)|rewrite|edit|save|move|archive|execute|generate|apply|fix|correct|change|modify|amend|cancel|void|rescind|replace|create|draft|sign|countersign|approve|accept|terminate|renew|transfer|submit|pay|evolve|update|set|configure|disable|enable|add|upload|reset|wipe|truncate|eras(?:e|es|ed|ing)|run\\s+(?:the\\s+)?(?:migration|deployment|script|command)|perform\\s+(?:(?:one|a|an|the|single)\\s+)?(?:api|gmail)\\s+(?:reply|response|send)|perform\\s+(?:(?:one|a|an|the|single)\\s+)?(?:reply|response|send)\\s+(?:through|via)\\s+(?:the\\s+)?(?:api|gmail)|${ENGLISH_SENSITIVE_TRANSFER_SOURCE})`;

const FRENCH_SENSITIVE_TRANSFER_SOURCE = '(?:(?:transf[eéè]r(?:er|e(?:z)?|ons?)|export(?:er|e(?:z)?|ons?)|envo(?:yer|ie(?:s)?|yez|yons)|partag(?:er|e(?:z)?|ons?)|adress(?:er|e(?:s|z)?|ons?)|attach(?:er|e(?:s|z)?|ons?)|(?:joindre|joins?|joignez|joignons|joint)|committ?(?:er|e(?:z)?|ons?)|copi(?:er|e(?:s|z)?|ons|é(?:e|es|s)?)|transmet(?:tre|s?|tez|tons)|transmis(?:e|es)?|inform(?:er|e(?:s)?|ez|ons?)|notifi(?:er|e(?:s)?|ez|ons?))(?:(?:\\s+(?!(?:et|puis|ensuite|mais)\\b)[\\p{L}\\p{N}\'’_-]+){0,5})\\s+(?:argent|fonds|paiements?|donn[ée]es?\\s+(?:clients?|personnelles?|utilisateurs?)|dossiers?\\s+clients?|identifiants?|mots?\\s+de\\s+passe|cl[ée]s?\\s+api|jetons?\\s+d[’\']accès))';

const ENGLISH_EXTERNAL_COMMUNICATION_SOURCE = String.raw`(?:send|inform|notify|contact|forward)`;

const FRENCH_EXTERNAL_COMMUNICATION_SOURCE = String.raw`(?:envo(?:yer|ie(?:s)?|yez|yons)|inform(?:er|e(?:s)?|ez|ons?)|notifi(?:er|e(?:s)?|ez|ons?)|contact(?:er|e(?:s)?|ez|ons?)|pr[ée]ven(?:ir|ez|ons)|pr[ée]vien(?:s|t|nent)|adress(?:er|e(?:s|z)?|ons?)|transmet(?:tre|s?|tez|tons))`;

const FRENCH_MUTATION_VERB_SOURCE = `(?:d[ée]plo(?:yer|ie(?:s)?|yez|yons)|publi(?:er|e(?:z)?|ons?)|supprim(?:er|e(?:z)?|ons?)|purge(?:r|z)?|migr(?:er|e(?:z)?|ons?)|restaur(?:er|e(?:z)?|ons?)|red[ée]marr(?:er|e(?:z)?|ons?)|arr[êe]t(?:er|e(?:z)?|ons?)|tourn(?:er|e(?:z)?|ons?)|r[ée]voqu(?:er|e(?:z)?|ons?)|accord(?:er|e(?:z)?|ons?)|autoris(?:er|e(?:z)?|ons?)|[ée]cri(?:re|s)|[ée]criv(?:ez|ons)|r[ée]dig(?:er|e(?:z)?|ons?)|[ée]dit(?:er|e(?:z)?|ons?)|sauvegard(?:er|e(?:z)?|ons?)|d[ée]pla(?:cer|ce(?:z)?|çons)|archiv(?:er|e(?:z)?|ons?)|ex[ée]cut(?:er|e(?:z)?|ons?)|appliqu(?:er|e(?:z)?|ons?)|corrig(?:er|e(?:z)?|ons?)|solutionn(?:er|e(?:z)?|ons?)|r[ée]sou(?:s|dre)|r[ée]solv(?:ez|ons)|relanc(?:er|e(?:z)?|ons?)|modifi(?:er|e(?:z)?|ons?)|rempla(?:cer|ce(?:z)?|çons)|impl[ée]ment(?:er|e(?:z)?|ons?)|implant(?:er|e(?:z)?|ons?)|cr[ée](?:er|e(?:z)?|ons?)|sign(?:er|e(?:z)?|ons?)|approuv(?:er|e(?:z)?|ons?)|soumet(?:tre|s)|pay(?:er|e(?:z)?|ons?)|(?:effectu(?:er|e(?:z)?|ons?)|proc[èe]d(?:er|e(?:z)?|ons?))\\s+(?:au|aux|le|les|un|une)?\\s*(?:paiement|virement|transaction)|effectu(?:er|e(?:z)?|ons?)\\s+(?:(?:une?|la)\\s+)?(?:unique\\s+)?(?:r[ée]ponse|envoi)\\s+(?:(?:via|par)\\s+)?(?:l['’]\\s*)?(?:api|gmail)|nettoi(?:yer|e(?:z)?|yons)|configur(?:er|e(?:z)?|ons?)|d[ée]sactiv(?:er|e(?:z)?|ons?)|activ(?:er|e(?:z)?|ons?)|ajout(?:er|e(?:z)?|ons?)|t[ée]l[ée]vers(?:er|e(?:z)?|ons?)|r[ée]initialis(?:er|e(?:z)?|ons?)|effa(?:cer|ce(?:s|z)?|çons|cé(?:e|es|s)?)|lanc(?:er|e(?:z)?|ons?)\\s+(?:la\\s+|le\\s+|une?\\s+)?(?:migration|d[ée]ploiement|script|commande)|(?:mettre|mets?|mettez|mettons)(?:\\s+[\\p{L}\\p{N}'’_-]+){0,8}\\s+(?:à\\s+jour|en\\s+production)|mettre à jour|mets à jour|mettez à jour|mettons à jour|fais évoluer|faites évoluer|${FRENCH_SENSITIVE_TRANSFER_SOURCE}|${FRENCH_EXTERNAL_COMMUNICATION_SOURCE})`;

const ADDITIONAL_FRENCH_LEGAL_MUTATION_VERB_SOURCE = String.raw`(?:r[ée][ée]cri(?:re|s|t)|r[ée][ée]criv(?:ez|ons)|amend(?:er|e(?:s|z)?|ons?)|annul(?:er|e(?:s|z)?|ons?)|contresign(?:er|e(?:z)?|ons?)|accept(?:er|e(?:z)?|ons?)|g[ée]n[éeè]r(?:er|e(?:z)?|ons?)|r[ée]sili(?:er|e(?:z)?|ons?)|renouvel(?:er|le(?:s|z)?|ons?)|transf[éeè]r(?:er|e(?:z)?|ons?))`;

export const MUTATION_VERB_SOURCE = `(?:${ENGLISH_MUTATION_VERB_SOURCE}|${ENGLISH_EXTERNAL_COMMUNICATION_SOURCE}|${FRENCH_MUTATION_VERB_SOURCE}|${ADDITIONAL_FRENCH_LEGAL_MUTATION_VERB_SOURCE})`;

export const MODAL_PASSIVE_MUTATION_PATTERN = /(?<![\p{L}\p{N}_])(?:(?:must|should)\s+be\s+(?:deleted|removed|disabled|reset|rotated|revoked|granted|authorized|published|deployed|modified|changed|updated|transferred|paid|signed|approved|created|wiped|erased)|(?:doi(?:t|vent)|devr(?:ait|aient))\s+[êe]tre\s+(?:supprim[ée]s?|retir[ée]s?|d[ée]sactiv[ée]s?|r[ée]initialis[ée]s?|tourn[ée]s?|r[ée]voqu[ée]s?|accord[ée]s?|autoris[ée]s?|publi[ée]s?|d[ée]ploy[ée]s?|modifi[ée]s?|chang[ée]s?|mis(?:e|es)?\s+[àa]\s+jour|transf[ée]r[ée]s?|pay[ée]s?|sign[ée]s?|approuv[ée]s?|cr[ée][ée]s?|effac[ée]s?))(?![\p{L}\p{N}_])/giu;

export const CONTEXTUAL_MEDICAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

export const DIRECT_CLINICAL_PRESCRIPTION_MUTATION_PATTERN = /(?<![\p{L}\p{N}_])(?:prescribe(?:s|d|ing)?|prescri(?:re|s|t|vez|vons))(?![\p{L}\p{N}_])/giu;

export const DIRECT_CLINICAL_PROCEDURE_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

export const DIRECT_CLINICAL_PATIENT_CARE_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

const LOCALLY_BOUND_CLINICAL_PROCEDURE_TARGET_SOURCE = String.raw`(?:[\p{L}\p{M}'’_-]{3,}(?:ectomie|ectomy|otomie|otomy|plastie|plasty|scopie|scopy|stomie|stomy)|biopsie|biopsy|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|perfusions?|infusions?|intubations?|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|hormonoth[ée]rapies?|hormone\s+therap(?:y|ies)|psychoth[ée]rapies?|psychotherap(?:y|ies)|chirurgies?|surgery|surgeries|physioth[ée]rapies?|physiotherap(?:y|ies)|kin[ée]sith[ée]rapies?|physical\s+therap(?:y|ies)|oxyg[ée]noth[ée]rapies?|oxygen\s+therap(?:y|ies)|g[ée]noth[ée]rapies?|gene\s+therap(?:y|ies)|vaccinations?|vaccines?)`;

export const LOCALLY_BOUND_CLINICAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${LOCALLY_BOUND_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);

export const LOCALLY_BOUND_CLINICAL_PATIENT_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b`,
  'iu',
);

export const LOCALLY_BOUND_CLINICAL_TRANSITION_PATTERN = new RegExp(
  String.raw`^${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);

export const LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:the|a|le|la|un|une)\s+)?${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);

export const ANY_ENGLISH_CLINICAL_ACTION_PATTERN = new RegExp(
  `^(?:${ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE}|${ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE}|${ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`,
  'iu',
);

export const BARE_ENGLISH_CLINICAL_ACTION_PATTERN = /^(?:adjust|change|modify|prescribe|reduce|lower|increase|decrease|raise|start|begin|initiate|commence|switch|stop|hold|withhold|suspend|cease|resume|restart|renew|double|halve|(?:up|down)?titrate|transition|replace|substitute|convert|taper|wean|escalate|de[- ]escalate|put|medicate|dose|administer|inject|infuse|give|order|discontinue|set|perform|conduct|operate|schedule|carry\s+out|do|undertake|intubate|extubate|transfuse|biopsy|vaccinate|immunize|inoculate)$/iu;

export const CONTEXTUAL_MEDICAL_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:traitements?|treatments?|dosages?|doses?|posologies?|m[ée]dicaments?|medications?)(?![\p{L}\p{N}_])/iu;

const LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE = String.raw`(?:antibiotiques?|antibiotics?|insulines?|insulins?|morphines?|warfarines?|warfarins?|prednisone|fentanyl|aspirine?|aspirin|h[ée]parine?|heparin|parac[ée]tamol|acetaminophen|metformin|ceftriaxone|[\p{L}\p{M}]{4,}(?:cillin|cycline|mycin|xone|pril|sartan|olol|statin|formin)|antiviraux?|antivirals?|antifongiques?|antifungals?|anticoagulants?|m[ée]dicaments?|medications?|m[ée]dicamenteu(?:x|se|ses)|pharmaceutiques?|pharmaceutical|clinical|clinique|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|hormonoth[ée]rapies?|hormone\s+therap(?:y|ies)|psychoth[ée]rapies?|psychotherap(?:y|ies)|chirurgies?|surgery|surgeries|physioth[ée]rapies?|physiotherap(?:y|ies)|kin[ée]sith[ée]rapies?|physical\s+therap(?:y|ies)|oxyg[ée]noth[ée]rapies?|oxygen\s+therap(?:y|ies)|g[ée]noth[ée]rapies?|gene\s+therap(?:y|ies)|insulinoth[ée]rapies?|insulin\s+therap(?:y|ies)|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|greffes?|transplantations?|(?:kidney|renal|liver|heart|lung|organ|bone\s+marrow)\s+transplants?|vaccinations?|vaccines?)`;

export const LOCALLY_BOUND_MEDICAL_TARGET_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?(?:(?:${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE})(?:\s+(?:therap(?:y|ies)|th[ée]rapies?|traitements?|treatments?|prescriptions?|ordonnances?|dosages?|doses?|posologies?|m[ée]dicaments?|medications?))?|(?!(?:lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|requests?|requ[êe]tes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)|(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)(?:\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE})?|(?:therap(?:y|ies)|th[ée]rapies?|traitements?|treatments?|m[ée]dicaments?|medications?))(?![\p{L}\p{N}_])`,
  'iu',
);

export const LOCALLY_BOUND_CLINICAL_PATIENT_ADMINISTRATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}(?:\b\d+(?:[.,]\d+)?\s*(?:mcg|mg|g|ml|iu|units?|unit[ée]s?)\b|\b${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE}\b))[^.!?;\n]{1,120}`,
  'iu',
);

export const DIRECT_RBAC_MUTATION_PATTERN = new RegExp(
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  'giu',
);

const OPERATIONAL_TREATMENT_OBJECT_SOURCE = String.raw`(?:lots?|batch(?:es)?|donn[ée]es?|data|r[ée]ponses?|responses?|requ[êe]tes?|requests?|apis?|pipelines?|plc|inventaires?|inventory|stocks?|candidatures?|applications?|clients?|customers?|fichiers?|files?|formulaires?|forms?|notifications?|s[ée]ances?|planning)`;

export const EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN = new RegExp(
  String.raw`^\s+(?:(?:(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?|for(?:\s+the)?)\s+)?(?:incoming\s+)?${OPERATIONAL_TREATMENT_OBJECT_SOURCE})(?![\p{L}\p{N}_])`,
  'iu',
);

const LOCALLY_BOUND_OPERATIONAL_TREATMENT_PATTERN = new RegExp(
  String.raw`^\s+(?:(?:le|la|les|l['’]|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*)?(?:(?:dosages?|doses?)\s+(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?)\s+)?(?:(?:lots?|batch(?:es)?)\s+)?(?:traitements?|treatments?)\s+(?:(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?|for(?:\s+the)?)\s+)?(?:incoming\s+)?${OPERATIONAL_TREATMENT_OBJECT_SOURCE}(?![\p{L}\p{N}_])`,
  'iu',
);

export function hasLocallyBoundOperationalTreatmentTarget(afterMutation: string): boolean {
  if (LOCALLY_BOUND_OPERATIONAL_TREATMENT_PATTERN.test(afterMutation)) return true;
  const localTarget = LOCALLY_BOUND_MEDICAL_TARGET_PATTERN.exec(afterMutation);
  return !!localTarget
    && EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN.test(afterMutation.slice(localTarget[0].length));
}

export const FRENCH_INFINITIVE_STATE_PREDICATE_SOURCE = String.raw`(?:est|[ée]tait|sera|serait|doi(?:t|vent)|devait|devra|devrait|peut|pourrait|semble(?:rait)?|para[iî]t(?:rait)?|rest(?:e|era|erait)|demeure(?:ra|rait)?|constitu(?:e|era|erait)|repr[ée]sent(?:e|era|erait)|s['’]\s*av[èe]r(?:e|era|erait)|dev(?:ient|iendra|iendrait)|appara[iî]t(?:rait)?|n[ée]cessit(?:e|era|erait)|impliqu(?:e|era|erait)|signifi(?:e|era|erait))`;

export const FRENCH_REACTIVATION_PATTERN = /(?<![\p{L}\p{N}_])r[ée]activ(?:er|e(?:s|z)?|ons?)(?![\p{L}\p{N}_])/giu;

export const EXTERNAL_COMMUNICATION_MUTATION_PATTERN = new RegExp(
  `^(?:${ENGLISH_EXTERNAL_COMMUNICATION_SOURCE}|${FRENCH_EXTERNAL_COMMUNICATION_SOURCE})$`,
  'iu',
);

export const READ_ONLY_OPERATION_PATTERN = /\b(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read)\b|\b(?:audite?|inspecte?|revue|analyse|explique|r[ée]sume|v[ée]rifie|contr[ôo]le|lis)\b/i;

export const ENGLISH_OBJECT_STATE_QUESTION_PATTERN = /^(?!(?:can|could|would|will)\s+you\b)(?:(?:(?:why|how|when|where)\s+)?(?:do|does|did|will|would|should|must|can|could|is|are|was|were|has|have)\b|(?:what|which|who)\b)[^?!\n]{1,220}\?$/i;

export const FRENCH_OBJECT_STATE_QUESTION_PATTERN = /^(?!(?:(?:est[- ]ce\s+que\s+)?(?:tu\s+(?:peux|pourrais|veux)|vous\s+(?:pouvez|pourriez|voulez))|(?:peux|pourrais|veux)-tu|(?:pouvez|pourriez|voulez)-vous)\b)(?:(?:est[- ]ce\s+que|pourquoi|comment|quand|o[uù]|quel(?:le)?s?)\b[^?!\n]{1,220}|[^?!\n]{1,180}\b[\p{L}]+-(?:t-)?(?:il|elle|ils|elles|on|je|tu|nous|vous)\b[^?!\n]{0,80})\s*\?$/iu;

export const AUDITED_PNS_POSTGRES_PREFIX_PATTERN = /^(?:docker|\/(?:usr\/)?(?:local\/)?bin\/docker)\s+exec\s+pnsgen-db\s+\/usr\/(?:bin|local\/bin)\/psql(?:\s|$)/;

export const AUDITED_PNS_POSTGRES_PROSE_BASE_PATTERN = /(?:docker|\/(?:usr\/)?(?:local\/)?bin\/docker)\s+exec\s+pnsgen-db\s+\/usr\/(?:bin|local\/bin)\/psql\s+-X\s+--single-transaction\s+--set=ON_ERROR_STOP=1\s+-U\s+postgres\s+-d\s+pnsgen/g;

export const AUDITED_PNS_POSTGRES_PROSE_QUERY_PATTERN = /--command="[^"\\\r\n]{1,16384}"/g;

export const AUDITED_PNS_POSTGRES_FORM_CUE_PATTERN = /\bforme\s+directe\s+auditée\b/iu;

export const AUDITED_PNS_POSTGRES_OBSERVATION_CUE_PATTERN = /\b(?:ex[ée]cute|execute|run)\s+(?:une?|an?|one)\s+(?:(?:seule?|single)\s+)?(?:observation|lecture|inspection|read)\s+(?:strictement\s+bornée|strictly\s+bounded)\b/iu;

export const AUDITED_PNS_POSTGRES_MUTATING_SQL_PATTERN = /\b(?:alter|analyze|call|cluster|comment|copy|create|deallocate|delete|do|drop|execute|grant|insert|listen|lock|merge|notify|prepare|refresh|reindex|reset|revoke|truncate|unlisten|update|vacuum)\b|\bset\s+transaction\s+read\s+write\b|\bselect\b[^"\r\n]{0,4096}\binto\b|\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/iu;

export const AUDITED_PNS_POSTGRES_UNVALIDATED_SQL_PATTERN = /\b(?:alter|analyze|begin|call|cluster|comment|commit|copy|create|deallocate|delete|do|drop|execute|grant|insert|listen|lock|merge|notify|prepare|refresh|reindex|release|reset|revoke|rollback|savepoint|select|set|truncate|unlisten|update|vacuum|values|with)\b/iu;

export const AUDITED_PNS_POSTGRES_EXTRA_CAPABILITY_PATTERN = /[\r\n|&;<>$`]|(?:^|[\s,])--?[A-Za-z]|(?:^|[\s,;])(?:\.\.\/|\.\/|\/)[A-Za-z0-9_.-]/iu;

export const AUDITED_PNS_POSTGRES_WRAPPER_PATTERN = /(?:^|[\s,;])(?:[A-Za-z_][A-Za-z0-9_]*\s*=|command\s+|env\s+|nice\s+|nohup\s+|ssh\s+|sudo\s+|timeout\s+)/iu;

export const MUTATION_SCOPE_BOUNDARY_PATTERN = /[!?;\n]+|\.(?![\p{L}\p{N}_])|,\s*(?:then|puis|ensuite)\b|\b(?:and then|then|but|puis|ensuite|mais|and|et)\b/giu;

export const INTRINSIC_SENSITIVE_MUTATION_PATTERN = /^(?:grant|authorize|revoke|rotate|pay|accord|autoris|r[ée]voqu|pay)/iu;

export const MUTATION_TARGET_PRONOUN_PATTERN = /^(?:\s*(?:them|it|those|these|cela|[çc]a)\b|\s*-\s*(?:les|la|le|l['’])\b|\s*(?:all|some|part)\s+(?:of\s+)?(?:them|it|those|these)\b|\s*(?:the\s+)?(?:(?:identified|reported|noted|remaining)\s+)?(?:issues?|problems?|findings?|gaps?)\b|\s*(?:une\s+partie|certain(?:e|es|s)?)\s+des?\s+(?:entr[ée]es|[ée]l[ée]ments|lignes|donn[ée]es)\b|\s*(?:les\s+)?(?:probl[èe]mes?|erreurs?|constats?|anomalies?|points?)\s+(?:relev[ée]s?|identifi[ée]s?|signal[ée]s?|trouv[ée]s?|restants?)\b)/iu;

export const MUTATION_TARGET_PREVERBAL_PRONOUN_PATTERN = /(?:\b(?:les|la|le)|l['’])\s*$/iu;

export const DOCUMENT_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:readme|docs?|documentation|report|summary|overview|typo|guide|runbook|article|blog post|plan|mockup|button|word|wording|spelling|label|translation|rapport|r[ée]sum[ée]|synth[èe]se|vue d['’]ensemble|coquille|billet|plan|maquette|bouton|mot|libell[ée]|orthographe|traduction)(?![\p{L}\p{N}_])/iu;

export const LINGUISTIC_EDIT_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:word|wording|spelling|label|translation|mot(?!\s+de\s+passe)|libell[ée]|orthographe|traduction)(?![\p{L}\p{N}_])/iu;

export const DOCUMENT_SUMMARY_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:summary|overview|r[ée]sum[ée]|synth[èe]se|vue d['’]ensemble)(?![\p{L}\p{N}_])/iu;

export const DOCUMENTED_CREDENTIAL_POLICY_PATTERN = /(?:\b(?:passwords?|credentials?|api keys?|access tokens?)\b[^.!?;\n]{0,48}\b(?:polic(?:y|ies)|rules?|requirements?|guidelines?|guidance)\b|\b(?:polic(?:y|ies)|rules?|requirements?|guidelines?|guidance)\b[^.!?;\n]{0,48}\b(?:passwords?|credentials?|api keys?|access tokens?)\b|\b(?:politique|r[èe]gles?|exigences?|consignes?)\b[^.!?;\n]{0,48}\b(?:mots?\s+de\s+passe|identifiants?|cl[ée]s?\s+api|jetons?\s+d['’]acc[èe]s)\b)/iu;

export const DOCUMENT_EDIT_MUTATION_PATTERN = /^(?:update|fix|create|write|edit|draft|save|replace|eras|mettre\b|mets?\b|mettez\b|mettons\b|corrig|cr[ée]|[ée]cri|[ée]dit|r[ée]dig|sauvegard|rempla|effa)/iu;

export const LOCAL_NON_OPERATIONAL_SENSITIVE_ARTIFACT_PATTERN = /(?<![\p{L}\p{N}_])(?:parsers?|parseurs?|unit\s+tests?|tests?\s+unitaires?|test\s+fixtures?|fixtures?|mocks?|stubs?|samples?|examples?|demos?|maquettes?|mockups?|css|styles?|styling|type\s+definitions?|definitions?\s+de\s+types?|sdk\s+types?|synthetic|synth[ée]tique|fake|factice)(?![\p{L}\p{N}_])/iu;

export const LOCAL_ARTIFACT_EDIT_MUTATION_PATTERN = /^(?:fix|create|update|edit|rename|replace|format|style|enable|disable|corrig|cr[ée]|mets?\s+[àa]\s+jour|mettre\s+[àa]\s+jour|[ée]dit|renomm|rempla|format|stylis|active|d[ée]sactive)/iu;

export const OPERATIONAL_SENSITIVE_EFFECT_PATTERN = /(?<![\p{L}\p{N}_])(?:pay|charge|debit|credit|transfer|wire|process(?:es|ed|ing)?\s+(?:a\s+)?payment|execute(?:s|d|ing)?\s+(?:a\s+)?transaction|submit(?:s|ted|ting)?\s+(?:a\s+)?payment|reset|rotate|revoke|grant|delete|remove|export|send|share|payer|facturer|d[ée]biter|cr[ée]diter|virer|transf[ée]rer|ex[ée]cuter\s+(?:une?\s+)?transaction|soumettre\s+(?:un\s+)?paiement|r[ée]initialiser|r[ée]voquer|accorder|supprimer|exporter|envoyer|partager)(?![\p{L}\p{N}_])/iu;

export const STRUCTURED_SENSITIVE_TARGET_PATTERN = /\b(?:selected\s+(?:rows?|records?|items?|entries)|spreadsheet|workbook|worksheet|data\s*set|rows?|records?|entries|results?|data|tableur|classeur|feuille\s+de\s+calcul|lignes?\s+s[ée]lectionn[ée]es?|enregistrements?|jeu\s+de\s+donn[ée]es|entr[ée]es|r[ée]sultats?|donn[ée]es)\b/iu;

export const READ_ONLY_OPERATION_START_PATTERN = /^\s*(?:(?:please|kindly|then|now|merci\s+de|veuillez|maintenant|puis|ensuite|(?:can|could|would)\s+you|peux-tu|pouvez-vous)\s+)?(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read|audite?|inspecte?|analyse|explique|r[ée]sume|v[ée]rifie|contr[ôo]le|lis|revois)(?![\p{L}\p{N}_])/iu;

export const READ_ONLY_NOMINAL_OPERATION_START_PATTERN = /^\s*(?:(?:perform|conduct|run|effectue|fais|r[ée]alise)\s+)(?:(?:an?|the|une?|le|la)\s+)?(?:audit|inspection|review|check|analyse|revue|contr[ôo]le)(?![\p{L}\p{N}_])/iu;

export const DECLARATIVE_CLAUSE_START_PATTERN = /^(?:(?:the|this|that|these|those|le|la|les|ce|cet|cette|ces|il|elle|ils|elles)\s+)[^.!?;\n]{0,100}\b(?:is|are|was|were|has|have|will|must|should|est|sont|[ée]tait|[ée]taient|a|ont|sera|seront|doit|doivent|devrait|devraient)\b/iu;

export const MUTATION_MODIFIER_ONLY_START_PATTERN = /^(?:then|and\s+then|puis|ensuite|after|before|following|once|when|whenever|if|subject\s+to|pending|as\s+soon\s+as|provided\s+that|apr[èe]s|avant|lorsque|quand|si|d[èe]s\s+que|aussit[oô]t|une\s+fois|[àa]\s+la\s+suite\s+de|[àa]\s+condition\s+que|pourvu\s+que|sous\s+r[ée]serve\s+de|en\s+attendant)\b/iu;

export const STRUCTURED_FIELD_DELIMITER_SOURCE = String.raw`(?:[:=]|\s+-\s+)`;

export const ACTION_ONLY_PREFIX_PATTERN = new RegExp(
  String.raw`^\s*(?:[-*+•]\s*)?(?:(?:action|operation|op[ée]ration|command|commande|task|t[âa]che|[àa]\s+faire)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*)?$`,
  'iu',
);

export const STRUCTURED_TARGET_FIELD_PATTERN = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:[-*+•]\s*)?(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*([^;\n]{1,200})`,
  'giu',
);
