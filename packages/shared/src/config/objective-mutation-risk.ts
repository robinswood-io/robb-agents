import { isReadOnlyRegisteredShellObservation } from '../agent/core/registered-observation.ts';
import {
  detectHighStakesEvidenceDomain,
  isDirectLegalDocumentMutation,
  DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE,
  DIRECT_CLINICAL_MODIFIER_SOURCE,
  DIRECT_CLINICAL_NAMED_PERSON_SOURCE,
  DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE,
  DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE,
  DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE,
  ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE,
  ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE,
  ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE,
} from '../agent/core/objective-evidence-gate.ts';
import {
  DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE,
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE,
} from '../agent/core/rbac-action-grammar.ts';
import type { SourceSensitivity } from './selection-provenance.ts';
const SENSITIVE_DOMAIN_PATTERN = /\b(?:secrets?|credentials?|passwords?|api key|api access|(?:api|customer|client|user) accounts?|accounts? (?:for )?(?:api|customers?|clients?|users?)|access token|oauth tokens?|tokens? oauth|payments?|invoices?|accounting|ledger|reconciliation|bank|financial|tax(?:es|ation)?|fiscal|legal|security|permissions?|rbac|acls?|access control lists?|(?:admin(?:istrator)?s? (?:roles?|groups?)|(?:roles?|groups?) (?:(?:of|for) )?admin(?:istrator)?s?)|promot(?:e|es|ed|ing) [^.!?;\n]{1,80} to (?:an? )?admin(?:istrator)|signature|notari[sz](?:e|ation)?|transaction|nda|non-disclosure|pii|personally identifiable information|personal data|customer (?:data|records?)|user records?|production (?:database|db|server))\b|(?:\bsecrets?\b|mot(?:s)? de passe|identifiant|\bacc[èe]s\s+api\b|\bcomptes?\s+(?:(?:de|du|des|pour)\s+(?:l['’]\s*)?)?(?:api|clients?|utilisateurs?)\b|jeton d['’]accès|(?:jetons?|tokens?) oauth|cl[ée] api|paiement|factur|comptab|bancaire|financier|fiscal|imp[oô]t|jurid|s[ée]curit|permission|rbac|acls?|r[oô]les?\s+(?:(?:de|des|pour\s+les?)\s+|d['’]\s*)?administrateurs?|groupes?\s+(?:(?:de|des|pour\s+les?)\s+|d['’]\s*)?administrateurs?|signature|notari|transaction|donn[ée]es? personnelles?|donn[ée]es? clients?|dossiers? clients?|base de donn[ée]es? de production|serveur de production)/i;

const DIRECT_RBAC_DOMAIN_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:${DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE}|${DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE})(?![\p{L}\p{N}_])`,
  'iu',
);

const CRITICAL_DOMAIN_PATTERN = /\b(?:secrets?|credentials?|passwords?|api keys?|api access|(?:api|customer|client|user) accounts?|accounts? (?:for )?(?:api|customers?|clients?|users?)|access tokens?|oauth tokens?|tokens? oauth|payments?|bank|transaction|pii|personally identifiable information|production (?:database|db|server)|customer (?:data|records?)|user records?|personal data)\b|\b(?:secrets?|mot(?:s)? de passe|identifiants?|acc[èe]s\s+api|comptes?\s+(?:(?:de|du|des|pour)\s+(?:l['’]\s*)?)?(?:api|clients?|utilisateurs?)|jetons? d['’]accès|(?:jetons?|tokens?) oauth|cl[ée]s? api|paiements?|bancaire|transaction|base de donn[ée]es? de production|serveur de production|donn[ée]es? clients?|dossiers? clients?|donn[ée]es? personnelles?)\b/i;

const NON_CREDENTIAL_OBSERVATION_IDENTIFIER_PATTERN = /(?<![\p{L}\p{N}_])identifiants?\s+d['’]\s*observations?(?![\p{L}\p{N}_])/giu;

const SENSITIVE_OBSERVATION_IDENTIFIER_QUALIFIER_PATTERN = /(?:\bidentifiants?\s+d['’]\s*observations?\b[^.!?;\n]{0,80}\b(?:compte|account|api|production|prod|authentification|authentication|connexion|login|secret|credentials?)\b|\b(?:compte|account|api|production|prod|authentification|authentication|connexion|login|secret|credentials?)\b[^.!?;\n]{0,80}\bidentifiants?\s+d['’]\s*observations?\b)/iu;

const PRODUCTION_ENVIRONMENT_RISK_PATTERN = /(?:\b(?:production|prod)\b.{0,80}\b(?:environment|server|database|db|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|erase|wipe|clean|purge|drop|restart|execute|write|apply|fix|change|modify)\b|\b(?:environment|server|database|db|cluster|application|service|site|branch|deploy|release|publish|migration|rollback|delete|remove|erase|wipe|clean|purge|drop|restart|execute|write|apply|fix|change|modify)\b.{0,80}\b(?:production|prod)\b|\bproduction\b.{0,80}\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|d[ée]plo(?:i|y)|publie|migration|restaure|supprim|effa|nettoi|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*|\b(?:environnement|serveur|base de données|cluster|application|service|site|branche|d[ée]plo(?:i|y)|publie|migration|restaure|supprim|effa|nettoi|purge|redémarr|exécut|lance|écris|appliqu|corrig|modifi)\w*.{0,80}\bproduction\b)/i;

const FRENCH_PRODUCTION_PROMOTION_PATTERN = /(?<![\p{L}\p{N}_])(?:mettre|mets?|mettez|mettons)(?:\s+[\p{L}\p{N}'’_-]+){0,8}\s+en\s+production(?![\p{L}\p{N}_])/iu;

const EXPLICIT_READ_ONLY_PATTERN = /\b(read[ -]?only|audit only|inspect only|verify only|no writes?|without (?:any )?(?:change|mutation|write))\b|\b(lecture seule|sans (?:aucune )?(?:modification|mutation|écriture)|aucune (?:modification|mutation|écriture)|vérifie seulement|contrôle seulement)/i;

const ENGLISH_SENSITIVE_TRANSFER_SOURCE = '(?:(?:transfer|send|export|commit|share|email(?:s|ed|ing)?|mail(?:s|ed|ing)?|attach(?:es|ed|ing)?|post(?:s|ed|ing)?|cop(?:y|ies|ied|ying)|forward(?:s|ed|ing)?|inform(?:s|ed|ing)?|notif(?:y|ies|ied|ying))(?:(?:\\s+(?!(?:and|then|but)\\b)[\\p{L}\\p{N}\'’_-]+){0,5})\\s+(?:money|funds?|payments?|customer\\s+(?:data|records?)|user\\s+records?|personal\\s+data|credentials?|passwords?|api\\s+keys?|access\\s+tokens?))';

const STRUCTURED_SOURCE_TRANSFER_VERB_SOURCE = String.raw`(?:export(?:s|ed|ing)?|shar(?:e|es|ed|ing)|send(?:s|ing)?|sent|email(?:s|ed|ing)?|mail(?:s|ed|ing)?|attach(?:es|ed|ing)?|post(?:s|ed|ing)?|forward(?:s|ed|ing)?|cop(?:y|ies|ied|ying)|export(?:er|e(?:z)?|ons?)|partag(?:er|e(?:z)?|ons?)|envo(?:yer|ie(?:s)?|yez|yons)|adress(?:er|e(?:s|z)?|ons?)|attach(?:er|e(?:s|z)?|ons?)|(?:joindre|joins?|joignez|joignons|joint)|transmet(?:tre|s?|tez|tons)|copi(?:er|e(?:s|z)?|ons|é(?:e|es|s)?))`;

const STRUCTURED_SOURCE_TRANSFER_TARGET_SOURCE = String.raw`(?:selected\s+(?:spreadsheet\s+)?rows?|spreadsheet|workbook|worksheet|data\s*set|rows?|records?|tableur|classeur|feuille\s+de\s+calcul|lignes?\s+s[ée]lectionn[ée]es?|enregistrements?|jeu\s+de\s+donn[ée]es)`;

const STRUCTURED_SOURCE_TRANSFER_PATTERN = new RegExp(
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

const MUTATION_VERB_SOURCE = `(?:${ENGLISH_MUTATION_VERB_SOURCE}|${ENGLISH_EXTERNAL_COMMUNICATION_SOURCE}|${FRENCH_MUTATION_VERB_SOURCE}|${ADDITIONAL_FRENCH_LEGAL_MUTATION_VERB_SOURCE})`;

const MODAL_PASSIVE_MUTATION_PATTERN = /(?<![\p{L}\p{N}_])(?:(?:must|should)\s+be\s+(?:deleted|removed|disabled|reset|rotated|revoked|granted|authorized|published|deployed|modified|changed|updated|transferred|paid|signed|approved|created|wiped|erased)|(?:doi(?:t|vent)|devr(?:ait|aient))\s+[êe]tre\s+(?:supprim[ée]s?|retir[ée]s?|d[ée]sactiv[ée]s?|r[ée]initialis[ée]s?|tourn[ée]s?|r[ée]voqu[ée]s?|accord[ée]s?|autoris[ée]s?|publi[ée]s?|d[ée]ploy[ée]s?|modifi[ée]s?|chang[ée]s?|mis(?:e|es)?\s+[àa]\s+jour|transf[ée]r[ée]s?|pay[ée]s?|sign[ée]s?|approuv[ée]s?|cr[ée][ée]s?|effac[ée]s?))(?![\p{L}\p{N}_])/giu;

const CONTEXTUAL_MEDICAL_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

const DIRECT_CLINICAL_PRESCRIPTION_MUTATION_PATTERN = /(?<![\p{L}\p{N}_])(?:prescribe(?:s|d|ing)?|prescri(?:re|s|t|vez|vons))(?![\p{L}\p{N}_])/giu;

const DIRECT_CLINICAL_PROCEDURE_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

const DIRECT_CLINICAL_PATIENT_CARE_MUTATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE}(?![\p{L}\p{N}_])`,
  'giu',
);

const LOCALLY_BOUND_CLINICAL_PROCEDURE_TARGET_SOURCE = String.raw`(?:[\p{L}\p{M}'’_-]{3,}(?:ectomie|ectomy|otomie|otomy|plastie|plasty|scopie|scopy|stomie|stomy)|biopsie|biopsy|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|perfusions?|infusions?|intubations?|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|hormonoth[ée]rapies?|hormone\s+therap(?:y|ies)|psychoth[ée]rapies?|psychotherap(?:y|ies)|chirurgies?|surgery|surgeries|physioth[ée]rapies?|physiotherap(?:y|ies)|kin[ée]sith[ée]rapies?|physical\s+therap(?:y|ies)|oxyg[ée]noth[ée]rapies?|oxygen\s+therap(?:y|ies)|g[ée]noth[ée]rapies?|gene\s+therap(?:y|ies)|vaccinations?|vaccines?)`;

const LOCALLY_BOUND_CLINICAL_PROCEDURE_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b|(?:(?:le|la|les|une?|the|an?)\s+)?${LOCALLY_BOUND_CLINICAL_PROCEDURE_TARGET_SOURCE}\b)`,
  'iu',
);

const LOCALLY_BOUND_CLINICAL_PATIENT_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:on|sur)\s+)?(?:(?:le|la|the|a)\s+)?patients?\b`,
  'iu',
);

const LOCALLY_BOUND_CLINICAL_TRANSITION_PATTERN = new RegExp(
  String.raw`^${DIRECT_CLINICAL_MEDICATION_TRANSITION_TAIL_SOURCE}`,
  'iu',
);

const LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:the|a|le|la|un|une)\s+)?${DIRECT_CLINICAL_NAMED_PERSON_SOURCE}(?![\p{L}\p{N}_])`,
  'u',
);

const ANY_ENGLISH_CLINICAL_ACTION_PATTERN = new RegExp(
  `^(?:${ENGLISH_CLINICAL_TREATMENT_ACTION_SOURCE}|${ENGLISH_CLINICAL_PROCEDURE_ACTION_SOURCE}|${ENGLISH_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`,
  'iu',
);

const BARE_ENGLISH_CLINICAL_ACTION_PATTERN = /^(?:adjust|change|modify|prescribe|reduce|lower|increase|decrease|raise|start|begin|initiate|commence|switch|stop|hold|withhold|suspend|cease|resume|restart|renew|double|halve|(?:up|down)?titrate|transition|replace|substitute|convert|taper|wean|escalate|de[- ]escalate|put|medicate|dose|administer|inject|infuse|give|order|discontinue|set|perform|conduct|operate|schedule|carry\s+out|do|undertake|intubate|extubate|transfuse|biopsy|vaccinate|immunize|inoculate)$/iu;

const CONTEXTUAL_MEDICAL_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:traitements?|treatments?|dosages?|doses?|posologies?|m[ée]dicaments?|medications?)(?![\p{L}\p{N}_])/iu;

const LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE = String.raw`(?:antibiotiques?|antibiotics?|insulines?|insulins?|morphines?|warfarines?|warfarins?|prednisone|fentanyl|aspirine?|aspirin|h[ée]parine?|heparin|parac[ée]tamol|acetaminophen|metformin|ceftriaxone|[\p{L}\p{M}]{4,}(?:cillin|cycline|mycin|xone|pril|sartan|olol|statin|formin)|antiviraux?|antivirals?|antifongiques?|antifungals?|anticoagulants?|m[ée]dicaments?|medications?|m[ée]dicamenteu(?:x|se|ses)|pharmaceutiques?|pharmaceutical|clinical|clinique|chimioth[ée]rapies?|chemotherap(?:y|ies)|radioth[ée]rapies?|radiotherap(?:y|ies)|dialyses?|dialysis|immunoth[ée]rapies?|immunotherap(?:y|ies)|hormonoth[ée]rapies?|hormone\s+therap(?:y|ies)|psychoth[ée]rapies?|psychotherap(?:y|ies)|chirurgies?|surgery|surgeries|physioth[ée]rapies?|physiotherap(?:y|ies)|kin[ée]sith[ée]rapies?|physical\s+therap(?:y|ies)|oxyg[ée]noth[ée]rapies?|oxygen\s+therap(?:y|ies)|g[ée]noth[ée]rapies?|gene\s+therap(?:y|ies)|insulinoth[ée]rapies?|insulin\s+therap(?:y|ies)|transfusions?(?:\s+sanguines?)?|blood\s+transfusions?|greffes?|transplantations?|(?:kidney|renal|liver|heart|lung|organ|bone\s+marrow)\s+transplants?|vaccinations?|vaccines?)`;

const LOCALLY_BOUND_MEDICAL_TARGET_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?:(?:le|la|les|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*|(?:de\s+)?l['’]\s*)?(?:(?:patients?\s*['’]s|du\s+patient|de\s+la\s+patiente)\s+)?(?:(?:${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE})(?:\s+(?:therap(?:y|ies)|th[ée]rapies?|traitements?|treatments?|prescriptions?|ordonnances?|dosages?|doses?|posologies?|m[ée]dicaments?|medications?))?|(?!(?:lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|requests?|requ[êe]tes?|files?|fichiers?|inventor(?:y|ies)|stocks?)\b)[\p{L}\p{M}][\p{L}\p{M}'’_-]*\s+(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)|(?:prescriptions?|ordonnances?|dosages?|doses?|posologies?)(?:\s+(?:(?:du|des|de|de\s+la|of(?:\s+the)?)\s+|(?:de\s+)?l['’]\s*|d['’]\s*)${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE})?|(?:therap(?:y|ies)|th[ée]rapies?|traitements?|treatments?|m[ée]dicaments?|medications?))(?![\p{L}\p{N}_])`,
  'iu',
);

const LOCALLY_BOUND_CLINICAL_PATIENT_ADMINISTRATION_PATTERN = new RegExp(
  String.raw`^\s+${DIRECT_CLINICAL_MODIFIER_SOURCE}(?=[^.!?;\n]{0,120}\bpatients?\b)(?=[^.!?;\n]{0,120}(?:\b\d+(?:[.,]\d+)?\s*(?:mcg|mg|g|ml|iu|units?|unit[ée]s?)\b|\b${LOCALLY_BOUND_CLINICAL_QUALIFIER_SOURCE}\b))[^.!?;\n]{1,120}`,
  'iu',
);

const DIRECT_RBAC_MUTATION_PATTERN = new RegExp(
  DIRECT_RBAC_MUTATION_ACTION_SOURCE,
  'giu',
);

const OPERATIONAL_TREATMENT_OBJECT_SOURCE = String.raw`(?:lots?|batch(?:es)?|donn[ée]es?|data|r[ée]ponses?|responses?|requ[êe]tes?|requests?|apis?|pipelines?|plc|inventaires?|inventory|stocks?|candidatures?|applications?|clients?|customers?|fichiers?|files?|formulaires?|forms?|notifications?|s[ée]ances?|planning)`;

const EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN = new RegExp(
  String.raw`^\s+(?:(?:(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?|for(?:\s+the)?)\s+)?(?:incoming\s+)?${OPERATIONAL_TREATMENT_OBJECT_SOURCE})(?![\p{L}\p{N}_])`,
  'iu',
);

const LOCALLY_BOUND_OPERATIONAL_TREATMENT_PATTERN = new RegExp(
  String.raw`^\s+(?:(?:le|la|les|l['’]|un|une|des|du|de\s+la|ce|cet|cette|ces|the|a|an|this|that)\s*)?(?:(?:dosages?|doses?)\s+(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?)\s+)?(?:(?:lots?|batch(?:es)?)\s+)?(?:traitements?|treatments?)\s+(?:(?:du|des|de\s+la|de\s+l['’]|of(?:\s+the)?|for(?:\s+the)?)\s+)?(?:incoming\s+)?${OPERATIONAL_TREATMENT_OBJECT_SOURCE}(?![\p{L}\p{N}_])`,
  'iu',
);

function hasLocallyBoundOperationalTreatmentTarget(afterMutation: string): boolean {
  if (LOCALLY_BOUND_OPERATIONAL_TREATMENT_PATTERN.test(afterMutation)) return true;
  const localTarget = LOCALLY_BOUND_MEDICAL_TARGET_PATTERN.exec(afterMutation);
  return !!localTarget
    && EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN.test(afterMutation.slice(localTarget[0].length));
}

const FRENCH_INFINITIVE_STATE_PREDICATE_SOURCE = String.raw`(?:est|[ée]tait|sera|serait|doi(?:t|vent)|devait|devra|devrait|peut|pourrait|semble(?:rait)?|para[iî]t(?:rait)?|rest(?:e|era|erait)|demeure(?:ra|rait)?|constitu(?:e|era|erait)|repr[ée]sent(?:e|era|erait)|s['’]\s*av[èe]r(?:e|era|erait)|dev(?:ient|iendra|iendrait)|appara[iî]t(?:rait)?|n[ée]cessit(?:e|era|erait)|impliqu(?:e|era|erait)|signifi(?:e|era|erait))`;

const FRENCH_REACTIVATION_PATTERN = /(?<![\p{L}\p{N}_])r[ée]activ(?:er|e(?:s|z)?|ons?)(?![\p{L}\p{N}_])/giu;

const EXTERNAL_COMMUNICATION_MUTATION_PATTERN = new RegExp(
  `^(?:${ENGLISH_EXTERNAL_COMMUNICATION_SOURCE}|${FRENCH_EXTERNAL_COMMUNICATION_SOURCE})$`,
  'iu',
);

const READ_ONLY_OPERATION_PATTERN = /\b(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read)\b|\b(?:audite?|inspecte?|revue|analyse|explique|r[ée]sume|v[ée]rifie|contr[ôo]le|lis)\b/i;

const ENGLISH_OBJECT_STATE_QUESTION_PATTERN = /^(?!(?:can|could|would|will)\s+you\b)(?:(?:(?:why|how|when|where)\s+)?(?:do|does|did|will|would|should|must|can|could|is|are|was|were|has|have)\b|(?:what|which|who)\b)[^?!\n]{1,220}\?$/i;

const FRENCH_OBJECT_STATE_QUESTION_PATTERN = /^(?!(?:(?:est[- ]ce\s+que\s+)?(?:tu\s+(?:peux|pourrais|veux)|vous\s+(?:pouvez|pourriez|voulez))|(?:peux|pourrais|veux)-tu|(?:pouvez|pourriez|voulez)-vous)\b)(?:(?:est[- ]ce\s+que|pourquoi|comment|quand|o[uù]|quel(?:le)?s?)\b[^?!\n]{1,220}|[^?!\n]{1,180}\b[\p{L}]+-(?:t-)?(?:il|elle|ils|elles|on|je|tu|nous|vous)\b[^?!\n]{0,80})\s*\?$/iu;

const AUDITED_PNS_POSTGRES_PREFIX_PATTERN = /^(?:docker|\/(?:usr\/)?(?:local\/)?bin\/docker)\s+exec\s+pnsgen-db\s+\/usr\/(?:bin|local\/bin)\/psql(?:\s|$)/;

const AUDITED_PNS_POSTGRES_PROSE_BASE_PATTERN = /(?:docker|\/(?:usr\/)?(?:local\/)?bin\/docker)\s+exec\s+pnsgen-db\s+\/usr\/(?:bin|local\/bin)\/psql\s+-X\s+--single-transaction\s+--set=ON_ERROR_STOP=1\s+-U\s+postgres\s+-d\s+pnsgen/g;

const AUDITED_PNS_POSTGRES_PROSE_QUERY_PATTERN = /--command="[^"\\\r\n]{1,16384}"/g;

const AUDITED_PNS_POSTGRES_FORM_CUE_PATTERN = /\bforme\s+directe\s+auditée\b/iu;

const AUDITED_PNS_POSTGRES_OBSERVATION_CUE_PATTERN = /\b(?:ex[ée]cute|execute|run)\s+(?:une?|an?|one)\s+(?:(?:seule?|single)\s+)?(?:observation|lecture|inspection|read)\s+(?:strictement\s+bornée|strictly\s+bounded)\b/iu;

const AUDITED_PNS_POSTGRES_MUTATING_SQL_PATTERN = /\b(?:alter|analyze|call|cluster|comment|copy|create|deallocate|delete|do|drop|execute|grant|insert|listen|lock|merge|notify|prepare|refresh|reindex|reset|revoke|truncate|unlisten|update|vacuum)\b|\bset\s+transaction\s+read\s+write\b|\bselect\b[^"\r\n]{0,4096}\binto\b|\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/iu;

const AUDITED_PNS_POSTGRES_UNVALIDATED_SQL_PATTERN = /\b(?:alter|analyze|begin|call|cluster|comment|commit|copy|create|deallocate|delete|do|drop|execute|grant|insert|listen|lock|merge|notify|prepare|refresh|reindex|release|reset|revoke|rollback|savepoint|select|set|truncate|unlisten|update|vacuum|values|with)\b/iu;

const AUDITED_PNS_POSTGRES_EXTRA_CAPABILITY_PATTERN = /[\r\n|&;<>$`]|(?:^|[\s,])--?[A-Za-z]|(?:^|[\s,;])(?:\.\.\/|\.\/|\/)[A-Za-z0-9_.-]/iu;

const AUDITED_PNS_POSTGRES_WRAPPER_PATTERN = /(?:^|[\s,;])(?:[A-Za-z_][A-Za-z0-9_]*\s*=|command\s+|env\s+|nice\s+|nohup\s+|ssh\s+|sudo\s+|timeout\s+)/iu;

export interface ObjectiveMutationRiskClassification {
  sensitiveDomain: boolean;
  mutationRequested: boolean;
  highRisk: boolean;
  criticalRisk: boolean;
  readOnlyRisk: boolean;
}

function isAuditedPnsPostgresReadOnlyCommand(text: string): boolean {
  const command = text.trim();
  return command.length > 0
    && AUDITED_PNS_POSTGRES_PREFIX_PATTERN.test(command)
    && isReadOnlyRegisteredShellObservation(command);
}

function maskRoutingTextMatch(match: string): string {
  return ' '.repeat(match.length);
}

function neutralizeNonCredentialObservationIdentifiers(text: string): string {
  if (SENSITIVE_OBSERVATION_IDENTIFIER_QUALIFIER_PATTERN.test(text)) return text;
  return text.replace(
    NON_CREDENTIAL_OBSERVATION_IDENTIFIER_PATTERN,
    match => maskRoutingTextMatch(match),
  );
}

function neutralizeAuditedPnsPostgresReadOnlyProse(
  text: string,
): { text: string; audited: boolean } {
  const bases = [...text.matchAll(AUDITED_PNS_POSTGRES_PROSE_BASE_PATTERN)];
  const queries = [...text.matchAll(AUDITED_PNS_POSTGRES_PROSE_QUERY_PATTERN)];
  if (bases.length !== 1 || queries.length > 1
    || AUDITED_PNS_POSTGRES_MUTATING_SQL_PATTERN.test(text)) {
    return { text, audited: false };
  }

  const base = bases[0]!;
  const query = queries[0];
  const beforeBase = text.slice(0, base.index);
  const hasExactImmediateEnvelopeCue = query
    ? /\ben\s+conservant\s+exactement\s*$/iu.test(beforeBase)
    : /\bforme\s+directe\s+auditée\s*$/iu.test(beforeBase);
  if (!hasExactImmediateEnvelopeCue) return { text, audited: false };
  const afterBase = text.slice(base.index + base[0].length);
  if (!/^(?:\s*,|\s+et\s+sans\s+shell\b|\s*$)/iu.test(afterBase)) {
    return { text, audited: false };
  }
  let shellAuditView = text.replace(base[0], maskRoutingTextMatch);
  if (query) shellAuditView = shellAuditView.replace(query[0], maskRoutingTextMatch);
  shellAuditView = shellAuditView.replace(/\bsans\s+sh\s+-lc\b/giu, maskRoutingTextMatch);
  if (AUDITED_PNS_POSTGRES_EXTRA_CAPABILITY_PATTERN.test(shellAuditView)
    || AUDITED_PNS_POSTGRES_WRAPPER_PATTERN.test(shellAuditView)
    || AUDITED_PNS_POSTGRES_UNVALIDATED_SQL_PATTERN.test(shellAuditView)) {
    return { text, audited: false };
  }

  const hasAuditedFormCue = AUDITED_PNS_POSTGRES_FORM_CUE_PATTERN.test(text);
  const hasObservationCue = AUDITED_PNS_POSTGRES_OBSERVATION_CUE_PATTERN.test(text);
  if (queries.length === 0 ? !hasAuditedFormCue : !hasObservationCue) {
    return { text, audited: false };
  }
  if (query
    && !isAuditedPnsPostgresReadOnlyCommand(`${base[0]} ${query[0]}`)) {
    return { text, audited: false };
  }

  let normalized = text
    .replace(/--single-transaction/g, maskRoutingTextMatch)
    .replace(/--set=ON_ERROR_STOP=1/g, maskRoutingTextMatch)
    .replace(/\bSET\s+TRANSACTION\s+READ\s+ONLY\b/giu, maskRoutingTextMatch)
    .replace(/\bSET\s+LOCAL\s+statement_timeout\s*=\s*([1-9]\d*)\b/giu, (match, timeout: string) => (
      Number(timeout) <= 60_000 ? maskRoutingTextMatch(match) : match
    ));
  normalized = normalized.replace(
    new RegExp(AUDITED_PNS_POSTGRES_OBSERVATION_CUE_PATTERN.source, 'giu'),
    maskRoutingTextMatch,
  );
  return { text: normalized, audited: true };
}

function isNonAuthoritativeMutation(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 140), index);
  const after = text.slice(index + length, index + length + 48);
  const mutation = text.slice(index, index + length).toLocaleLowerCase();
  const frenchReactivation = /^r[ée]activ(?:er|e(?:z)?|ons?)$/iu.test(mutation);
  const localClauseStart = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  const localClauseTail = text.slice(index + length).search(/[.!?;\n]/u);
  const localClauseEnd = localClauseTail < 0
    ? text.length
    : index + length + localClauseTail;
  const localClause = text.slice(localClauseStart + 1, localClauseEnd);
  // “Ne t’arrête que si un secret manque” constrains the agent's own stopping
  // condition; it neither rotates nor modifies that secret. Keep this narrow
  // to self-directed stop wording so “arrête le service” and explicit secret
  // mutations continue through the normal high-risk path.
  const conditionalSelfStop = /^(?:stop|arr[êe]t(?:er|e(?:z)?|ons?))$/iu.test(mutation)
    && /(?:\bne\s+(?:t['’]\s*|vous\s+)?arr[êe]t(?:e|ez)\s+que\s+si|\b(?:do\s+not|don['’]t)\s+stop\s+(?:working|your\s+work)\s+unless|\bonly\s+stop\s+(?:working|your\s+work)\s+if)\b/iu.test(localClause);
  const conditionalTargetStop = /^stop$/iu.test(mutation)
    && /\b(?:do\s+not|don['’]t)\s+stop\b[^.!?;\n]{0,80}\bunless\b/iu.test(localClause)
    && !conditionalSelfStop;
  const conditionalImperativeBefore = /(?:(?:\band\s*,?\s*)?\bif\s+(?:not|(?:it|that)\s+(?:does\s+not|doesn['’]t))|\botherwise|(?:\bet\s*,?\s*)?(?:\bsinon|\bsi\s+ce\s+n['’]est\s+pas\s+le\s+cas|\bs['’]il\s+ne(?:\s+[\p{L}\p{N}'’_-]+){0,6}\s+pas))\s*[,;:]?\s*(?:(?:please|(?:can|could)\s+you|merci\s+de|peux-tu|pouvez-vous)\s+)?(?:(?:l['’]|les?\s+|la\s+))?$/iu.test(before);
  const sequentialImperativeBefore = /(?:\b(?:and\s+)?then|\bpuis|\bensuite)\s*[,;:]?\s*(?:(?:please|(?:can|could|would)\s+you|merci\s+de|peux-tu|pouvez-vous)\s+)?(?:(?:l['’]|les?\s+|la\s+))?$/iu.test(before);
  const objectStateQuestion = (
    ENGLISH_OBJECT_STATE_QUESTION_PATTERN.test(text.trim())
      || FRENCH_OBJECT_STATE_QUESTION_PATTERN.test(text.trim())
  ) && !conditionalImperativeBefore && !sequentialImperativeBefore;
  const negatedBefore = /(?:\bdo\s+not|\bdon['’]t|\bnever|\b(?:must|should)(?:\s+not|n['’]t)|\b(?:is|are|was|were)\s+not\s+to|\bcannot|\bcan['’]t|\bwill\s+not|\bwon['’]t|\bwithout|\bsans|\bnul\s+besoin\s+de|\bne(?:\s+[\p{L}\p{N}'’_-]+){0,3}\s+(?:pas|jamais|plus))\b(?:\s+[\p{L}\p{N}'’_-]+){0,5}\s*$/iu.test(before);
  const frenchWrappedNegation = /(?:\bne|\bn['’])(?:\s+[\p{L}\p{N}'’_-]+){0,4}\s*$/iu.test(before)
    && /^\s+(?:pas|jamais|plus|rien|aucun(?:e)?)\b/iu.test(after)
    // A named exception is affirmative work ("ne crée aucun fichier sauf le
    // rapport") and must not be erased with the surrounding prohibition.
    && !/^\s+aucun(?:e)?\b[^.!?;\n]{0,120}\bsauf\s+(?:le|la|les|un|une|des|l['’])/iu.test(after);
  const frenchNegationInsideMutation = /(?:\bne|\bn['’])\s*$/iu.test(before)
    && /^(?:[\p{L}\p{N}'’_-]+)(?:\s+[\p{L}\p{N}'’_-]+){0,3}\s+(?:pas|jamais|plus|rien)\b/iu.test(mutation);
  const hypotheticalBefore = /(?:\bwhether\s+to|\bdecide\s+whether\s+to|\bhow\s+to|\b(?:explain|describe|review|analyse|analyze).{0,80}\bif\s+(?:we|i|you|they)\b|\bwhat\s+(?:happens|would\s+happen)\s+if\s+(?:we|i|you|they)\b|\bshould\s+(?:we|i|you)(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\bsi\s+(?:on|nous|je|tu|vous|ils?|elles?)\s+(?:doi(?:s|t|vent)|dev(?:ons|ez|ions)|devrait|devrions|faut)(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\bdev(?:ons|ez)-nous(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\b(?:review|inspect|audit|analyse|analyze).{0,80}\bplan\s+to(?:\s+[\p{L}\p{N}'’_-]+){0,6})\s*$/iu.test(before)
    || /(?:\b(?:explique|d[ée]cris|analyse)\b.{0,80}\bce\s+qui\s+(?:se\s+passe|arriv(?:e|erait))\s+si\s+(?:on|nous|je|tu|vous|ils?|elles?)|(?:^|[^\p{L}\p{N}_])(?:que\s+se\s+passe-t-il|qu['’]arriverait-il)\s+si\s+(?:on|nous|je|tu|vous|ils?|elles?)|\b(?:analyse|analyze|audite?|audit|inspecte?|inspect|examine|explique|explain|review|v[ée]rifie|revois)\b.{0,80}\b(?:comment|how\s+to)\s*|\b(?:analyse|audite|inspecte|examine|v[ée]rifie|revois)\b.{0,80}\bplan\s+(?:pour|de))\s*$/iu.test(before);
  const analyticalIndirectMutationBefore = /(?:^|[.!?;\n])\s*(?:(?:please|kindly)\s+|merci\s+d['’]?\s*)?(?:analy[sz]e|analys(?:e|er|ez|ons)|review|explain|evaluate|assess|[ée]valu(?:e|er|ez|ons))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
  const negatedAnalyticalIndirectMutationBefore = /(?:^|[.!?;\n])\s*(?:(?:do\s+not|don['’]t|never)\s+(?:analy[sz]e|review|explain|evaluate|assess)|(?:ne\s+|n['’]\s*)(?:analys(?:e|er|ez|ons)|revois|expliqu(?:e|er|ez|ons)|[ée]valu(?:e|er|ez|ons))\s+(?:pas|jamais))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
  const frenchDecisionQuestionBefore = /(?:(?:est-ce\s+que\s+)?(?:je|nous|on)\s+(?:dois|devrais|puis|pourrais|devons|devrions|pouvons|pourrions)|(?:dois|devrais|puis|pourrais)-je|(?:devons|devrions|pouvons|pourrions)-nous|(?:doit|devrait|peut|pourrait)-on)\s*$/iu.test(before)
    && /\?\s*$/u.test(text.trim());
  const reportedSpeechBefore = /(?:\b(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)\s*[:：-]?\s*(?:(?:that\s+)?(?:we|you|they|i|admins?|administrators?|nurses?|doctors?|staff)\s+(?:(?:should|must|need(?:s)?\s+to|can|could|would)\s+|to\s+)|(?:that\s+)?(?:the\s+)?(?:admins?|administrators?|nurses?|doctors?|staff)\s+to\s+|(?:that\s+)?|to\s+|then\s+)?$/iu.test(before)
    || /(?:\b(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne)\s*[:：-]?\s*(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu|les?\s+(?:admins?|administrat(?:eur|rice)s?|infirmi(?:er|[èe]re)s?|m[ée]decins?|responsables?))\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+|(?:ensuite\s+)?(?:de\s+|d['’]\s*)|ensuite\s+)?$/iu.test(before)
    || /(?:\b(?:le|la|un|une)\s+)?(?:m[ée]decin|docteur|docteure|clinicien|clinicienne)s?\s+(?:(?:recommande|conseille|propose|sugg[èe]re)\s+(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+|de\s+|d['’]\s*)|(?:dit|indique|d[ée]clare|mentionne)\s*[:：-]?\s*(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+)?)$/iu.test(before)
    || /(?:\b(?:the|a)\s+)?(?:doctor|physician|clinician)s?\s+(?:(?:recommends?|advises?|proposes?|suggests?)\s+(?:(?:that\s+)?(?:we|you|they|i)\s+(?:(?:should|must|need(?:s)?\s+to|can|could|would)\s+)?|(?:to\s+)?)|(?:says?|states?|declares?|mentions?)\s*[:：-]?\s*(?:(?:that\s+)?(?:we|you|they|i)\s+(?:should|must|need(?:s)?\s+to|can|could|would)\s+|to\s+)?)$/iu.test(before)
    || /(?:\baccording\s+to\s+(?:the\s+)?(?:doctor|physician|clinician)|\bselon\s+(?:le|la|un|une)\s+(?:m[ée]decin|docteur|docteure|clinicien|clinicienne))\b[^.!?;\n]{0,100}(?:\b(?:we|you|they|i)\s+(?:should|must|need(?:s)?\s+to)|\b(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent))|\bil\s+faut)\s*$/iu.test(before);
  const governedByReportedStatement = /(?:^|[.!?;\n])\s*(?:(?:(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)|(?:(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne))\b[^.!?;\n]{0,160}$/iu.test(before);
  const inspectedInstructionBefore = /\b(?:review|analyse|analyze|inspect|audit|explain)\s+(?:(?:this|that|these|those|the|an?)\s+)?(?:instructions?|prompts?|commands?|requests?|guidelines?|guides?)\s*[:：]\s*[^.!?;\n]{0,96}$/iu.test(before)
    || /\b(?:analyse|audite?|inspecte?|examine|explique|revois)\s+(?:(?:ce|cet|cette|ces|le|la|les|un|une)\s+)?(?:instructions?|consignes?|commandes?|requ[êe]tes?|directives?|guides?)\s*[:：]\s*[^.!?;\n]{0,96}$/iu.test(before);
  const documentaryHowTo = /(?:^|[.!?;\n])\s*(?:(?:(?:could|can|would)\s+you|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous)\s+)?(?:document(?:e|ez|er)|d[ée]cri(?:s|vez|re)|expliqu(?:e|ez|er)|r[ée]dig(?:e|ez|er)|write|draft|document|describe|explain)\b[^.!?;\n]{0,100}\b(?:comment|how\s+to|la\s+mani[èe]re\s+(?:de\s+|d['’]\s*)|l['’]option\s+de)\s*$/iu.test(before);
  const governedPlanningOrDesign = /(?:^|[.!?;\n])\s*(?:(?:draft|write|create|show|review|explain|r[ée]dig(?:e|ez|er)|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre|analyse|expliqu(?:e|ez|er))\b[^.!?;\n]{0,120}\b(?:plans?\s+(?:to|pour)|mockups?\s+(?:of|for)|maquettes?\s+(?:du|de\s+la|des)|boutons?\s+(?:pour|de|du)|options?\s+(?:to|de)|whether\s+(?:we\s+)?should|s['’]il\s+faut)\s*|(?:je\s+veux\s+savoir|i\s+want\s+to\s+know)\b[^.!?;\n]{0,80}\b(?:s['’]il\s+faut|whether\s+(?:we\s+)?should)\s*)$/iu.test(before);
  const governedMockupButton = /(?:^|[.!?;\n])\s*(?:show|create|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre)\b[^.!?;\n]{0,120}\b(?:mockups?|maquettes?)\b[^.!?;\n]{0,80}\b(?:buttons?|boutons?)\b/iu.test(`${before} ${after}`);
  const quotePairs: Array<readonly [string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
    ['`', '`'],
  ];
  const insideQuotedSpan = quotePairs.some(([open, close]) => {
    const opening = text.lastIndexOf(open, index - 1);
    if (opening < 0) return false;
    const closingBefore = text.lastIndexOf(close, index - 1);
    const closingAfter = text.indexOf(close, index + length);
    return (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
      && closingAfter >= index + length;
  });
  // Sensitive English mutations use the bare verb for an imperative. Past,
  // progressive and third-person forms describe observed work unless they are
  // explicitly governed by an imperative lead (for example "start
  // administering"). This prevents status prose from creating new authority.
  const inflectedSensitiveEnglishAction = (
    ANY_ENGLISH_CLINICAL_ACTION_PATTERN.test(mutation)
    && !BARE_ENGLISH_CLINICAL_ACTION_PATTERN.test(mutation)
  ) || /^(?:(?:assign|invit|demot|disabl|enabl|activat|deactivat|suspend|includ|exclud|transfer|convert|provid|allow|authoriz|promot|grant|revok|remov|appoint|elevat|nam|add)(?:s|es|ed|d|ing)|chang(?:es|ed|ing)|den(?:ies|ied|ying)|permits|permitted|permitting|gives|giving|given|gave|makes|making|made)$/iu.test(mutation);
  const frenchImperativeContext = /^suspends$/iu.test(mutation)
    && /^\s+(?:(?:le|la|les|un|une)\s+|l['’]\s*)/iu.test(after);
  const inflectedActionRequestLead = /\b(?:start|continue|keep|begin|please|then)\s*$/iu.test(before);
  const narratedSensitiveAction = inflectedSensitiveEnglishAction
    && !inflectedActionRequestLead && !frenchImperativeContext;
  const explicitSubjectBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
  const frenchThirdPersonSensitiveAction = /^(?:attribue|assigne|ajoute|donne|accorde|octroie|r[ée]voque|retire|supprime|active|d[ée]sactive|suspend|autorise|interdit|refuse|permet|transf[èe]re|invite|r[ée]trograde|inclue|exclue|change|convertit|met|nomme|promeut|d[ée]signe|[ée]l[èe]ve|rend|adapte|ajuste|prescrit|r[ée]duit|diminue|baisse|passe|augmente|commence|initie|titre|double|divise|remplace|substitue|s[èe]vre|interrompt|reprend|red[ée]marre|renouvelle|transitionne|cesse|arr[êe]te|administre|injecte|perfuse|donne|ordonne|vaccine|immunise|inocule|intube|extube|transfuse|biopsie|pose|effectue|r[ée]alise|pratique|op[èe]re|planifie|programme|fait)$/iu.test(mutation)
    || /ent$/iu.test(mutation) && (
      new RegExp(`^(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}|${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}|${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu').test(mutation)
    );
  const englishRoleOrPronounSubject = /^(?:(?:the|a|an)\s+(?:doctor|physician|clinician|nurse|surgeon|manager|administrator|operator|technician)|(?:he|she|they))$/iu.test(explicitSubjectBefore);
  const frenchNominalOrPronounSubject = frenchThirdPersonSensitiveAction
    && /^(?:(?:le|la|l['’]|un|une|ce|cet|cette)\s+[\p{L}\p{M}'’_-]+(?:\s+[\p{L}\p{M}'’_-]+){0,2}|il|elle|ils|elles)$/iu.test(explicitSubjectBefore);
  const namedFrenchSubject = frenchThirdPersonSensitiveAction
    && /^(?!(?:Puis|Ensuite|Maintenant|Veuillez|Merci|Enfin|Alors|Please|Kindly|Then|Now)$)[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
  const namedEnglishSubject = /^(?:set|put)$/iu.test(mutation)
    && /^(?!(?:Please|Then|Now|Kindly)$)[A-Z][\p{L}\p{M}'’_-]+(?:\s+[A-Z][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
  const passiveSensitiveEnglishAction = /^(?:set|put)$/iu.test(mutation)
    && /\b(?:is|are|was|were|has\s+been|have\s+been|had\s+been)\s*$/iu.test(before);
  const passiveSensitiveFrenchAction = /\b(?:est|sont|[ée]tait|[ée]taient|a|ont|avait|avaient|sera|seront)\s+(?:[ée]t[ée]\s+)?$/iu.test(before)
    && /(?:[ée](?:e|es|s)?|u(?:e|es|s)?|it|is|t|fait)$/iu.test(mutation);
  const narratedFrenchSubject = englishRoleOrPronounSubject
    || frenchNominalOrPronounSubject || namedFrenchSubject || namedEnglishSubject;
  const nominalReadOnlyObject = /^(?:fix|change|update|review|release|rollback)$/u.test(mutation)
    && /\b(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read)\s+(?:(?:the|this|that|a|an)\s+)?(?:[\p{L}\p{N}'’_-]+\s+){0,4}$/iu.test(before);
  const contextualMedicalMutation = /^(?:adjust|prescribe|reduce|start|give|gave|adapt(?:er|e(?:s|z)?|ons?)|prescri(?:re|s|t|vez|vons)|r[ée]dui(?:re|s|t|sez|sons)|commenc(?:er|e(?:s|z)?|ons?)|donn(?:er|e(?:s|z)?|ons?))$/iu.test(mutation);
  // Mutation candidates are already from a closed action vocabulary. Apply
  // the subject-description guard to every French infinitive in that set, not
  // only the medical/reactivation compatibility additions.
  const frenchInfinitive = /(?:er|ir|re)$/iu.test(mutation);
  const localClauseBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
  const bareInfinitiveTaskLead = /^(?:(?:[-*+•]|\d+[.)])\s*|(?:action|[àa]\s+faire|t[âa]che)\s*:\s*)?$/iu.test(localClauseBefore);
  const interrogativeOrProposalBefore = /(?:\b(?:faut-il|devrait-on|peut-on|doit-on)|\b(?:il\s+faudrait|on\s+pourrait|nous\s+pourrions)|\b(?:we|i|you|they)\s+(?:could|might))\s*$/iu.test(before);
  const bareMutationQuestion = /^\s*$/u.test(before)
    && /\?\s*$/u.test(text.slice(index + length).split(/[.!;\n]/u, 1)[0] ?? '');
  const infinitiveSubjectDescription = frenchInfinitive && bareInfinitiveTaskLead
    && new RegExp(
      // Do not mistake a later independent clause such as "c'est ta mission"
      // for the predicate whose grammatical subject is the infinitive.
      String.raw`^\s+[^.!?;\n]{0,120}(?<!c['’])(?<!c )(?<![\p{L}\p{N}_])${FRENCH_INFINITIVE_STATE_PREDICATE_SOURCE}(?![\p{L}\p{N}_])`,
      'iu',
    ).test(after);
  const englishInfinitiveTopic = /(?:^|[.!?;\n])\s*(?:to|the\s+(?:option|proposal|idea|plan)\s+to)\s*$/iu.test(before)
    && /^\s+[^.!?;\n]{0,160}\b(?:is|are|was|were|will\s+be|remains?|seems?|becomes?|requires?|implies?|means?)\b/iu.test(after);
  // `réactiver` was added for a concrete imperative missed in production.
  // Keep that recovery request-shaped: purpose/questions, analysis prompts and
  // infinitive subject statements describe the action but do not authorize it.
  const nonRequestReactivation = frenchReactivation && (
    /(?:^|[.!?;:]\s*)(?:pour|afin\s+de)\s*$/iu.test(before)
    || /\b(?:analyse|analyser|audite?|inspecte?|examine|explique|v[ée]rifie|revois)\b.{0,80}\bcomment\s*$/iu.test(before)
  );
  return (negatedBefore && !conditionalTargetStop)
    || frenchWrappedNegation || frenchNegationInsideMutation || hypotheticalBefore
    || analyticalIndirectMutationBefore || negatedAnalyticalIndirectMutationBefore
    || frenchDecisionQuestionBefore
    || reportedSpeechBefore || governedByReportedStatement || inspectedInstructionBefore
    || documentaryHowTo || governedPlanningOrDesign || governedMockupButton || insideQuotedSpan
    || nominalReadOnlyObject || objectStateQuestion || interrogativeOrProposalBefore
    || bareMutationQuestion || infinitiveSubjectDescription || englishInfinitiveTopic
    || nonRequestReactivation || conditionalSelfStop || narratedSensitiveAction
    || passiveSensitiveEnglishAction
    || passiveSensitiveFrenchAction
    || narratedFrenchSubject;
}

function isAuthoritativeModalPassive(text: string, index: number, length: number): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  const before = text.slice(clauseStart + 1, index);
  const after = text.slice(index + length);
  if (/\?\s*$/u.test(after.split(/[.!;\n]/u, 1)[0] ?? '')) return false;
  if (/(?:\bne|\bn['’])\s*$/iu.test(before)) return false;
  if (/^\s*(?:(?:example|exemple|documentation|docs?|guide|policy|politique|fixture|test|sample|extrait|quote|citation)\s*:|(?:(?:the|this|that|le|la|ce|cet|cette)\s+)?(?:documentation|document|guide|policy|politique|report|rapport|message|text|texte)\b[^.!?;\n]{0,120}\b(?:says?|states?|mentions?|indique|dit|mentionne)\b)/iu.test(before)) {
    return false;
  }
  const quotePairs: Array<readonly [string, string]> = [['"', '"'], ['“', '”'], ['«', '»'], ['`', '`']];
  return !quotePairs.some(([open, close]) => {
    const opening = text.lastIndexOf(open, index - 1);
    const closingBefore = text.lastIndexOf(close, index - 1);
    const closingAfter = text.indexOf(close, index + length);
    return opening >= 0
      && (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
      && closingAfter >= index + length;
  });
}

function isAuthoritativeFrenchReactivation(
  text: string,
  index: number,
  mutation: string,
): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('\n', index - 1),
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf(';', index - 1),
  );
  const before = text.slice(clauseStart + 1, index).trim();
  const after = text.slice(index + mutation.length);
  const priorContext = text.slice(0, clauseStart + 1)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
  const priorAuthorityContext = priorContext.replace(/(?:^|\n)\s*\d+[.)]\s*$/u, '');
  const nonAuthoritativePriorContext = /(?:^|[.!?;\n])\s*(?:exemple|example|citation|quote|sujet|subject|question|hypothese|option|proposition|scenario|consigne\s+citee|texte\s+a\s+analyser|plan\s+(?:propose|proposed))\s*:?\s*$/.test(priorAuthorityContext)
    || /(?:^|[.!?;\n])\s*(?:(?:le|la)\s+)?(?:rapport|report|document|documentation|texte|text|message)\b.{0,100}\b(?:dit|says?|indique|mentions?|recommande|recommends?)\s*:?\s*$/.test(priorAuthorityContext)
    || /(?:^|[.!?;\n])\s*analyse\b.{0,100}\b(?:instruction|option|si|whether)\b.{0,40}:?\s*$/.test(priorAuthorityContext);
  if (nonAuthoritativePriorContext) return false;
  const politeLead = String.raw`(?:ok|oui|d['’]accord|vas-y|allez-y|merci)`;
  const temporal = String.raw`(?:maintenant|d[ée]sormais|tout\s+de\s+suite)`;
  const requestFiller = String.raw`(?:${temporal}|stp|svp|s['’]\s*il\s+te\s+pla[iî]t|s['’]\s*il\s+vous\s+pla[iî]t)`;
  const requestBody = String.raw`(?:tu\s+(?:dois|peux|vas)|vous\s+(?:devez|pouvez|allez)|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous|est-ce\s+que\s+(?:tu\s+peux|vous\s+pouvez)|merci\s+de|je\s+(?:te|vous)\s+demande(?:\s+${requestFiller})?\s+de|je\s+(?:veux|souhaite|voudrais)\s+que\s+(?:tu|vous)|j['’]\s*ai\s+besoin\s+que\s+(?:tu|vous)|il\s+faut(?:\s+${requestFiller})?(?:\s+que\s+(?:tu|vous))?|veuillez|puis|ensuite)`;
  const structuredRequestPrefix = new RegExp(
    `^(?:(?:${politeLead})\\s*[,;:]?\\s*)?(?:(?:${temporal})\\s+)?(?:${requestBody})(?:\\s+(?:${requestFiller}))?$`,
    'iu',
  );
  const standaloneRequestLead = new RegExp(
    `^(?:${politeLead}|${temporal})\\s*[,;:]?$`,
    'iu',
  );
  if (structuredRequestPrefix.test(before) || standaloneRequestLead.test(before)) return true;
  const directTaskPrefix = /^(?:[-*+•]|(?:action|[àa]\s+faire|t[âa]che)\s*:)$/iu.test(before)
    && text.slice(0, clauseStart + 1).trim().length === 0;
  const directDevLoginTarget = /^[^.!?;\n]{0,96}(?:dev(?:eloppement)?\s+login|login\s+(?:de\s+)?d[ée]v(?:eloppement)?)(?![\p{L}\p{N}_])/iu.test(after);
  const directStructuredTask = /^\s*(?:action|[àa]\s+faire|t[âa]che)\s*:\s*(?:\r?\n)\s*(?:[-*+•]|\d+[.)])?\s*$/iu.test(text.slice(0, index));
  if ((directTaskPrefix || directStructuredTask) && directDevLoginTarget) return true;
  if (before) return false;

  const infinitive = /er$/iu.test(mutation);
  if (!infinitive) {
    return !/^\s*-(?:t-)?(?:il|elle|on|ils|elles)\b/iu.test(after);
  }
  // A bare infinitive is a common French task-list imperative. Questions,
  // alternatives and modal/state assertions are not.
  return !/\?/u.test(after.split(/[.!;\n]/u, 1)[0] ?? '')
    && !/^\s+[^.!?;\n]{0,120}\b(?:ou\s+non|est|serait|semble(?:rait)?|para[iî]t(?:rait)?|peut|pourrait|devrait)\b/iu.test(after);
}

function authoritativeMutationMatches(
  text: string,
  structuredSensitive = false,
): Array<{ index: number; length: number }> {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${MUTATION_VERB_SOURCE}(?![\\p{L}\\p{N}_])`, 'giu');
  const contextualMedicalMutation = detectHighStakesEvidenceDomain(text) === 'medical';
  const contextualMedicalMatches = contextualMedicalMutation
    ? [...text.matchAll(CONTEXTUAL_MEDICAL_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (() => {
        const afterMutation = text.slice(match.index + match[0].length);
        const localTarget = LOCALLY_BOUND_MEDICAL_TARGET_PATTERN.exec(afterMutation);
        if (!localTarget) {
          return LOCALLY_BOUND_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(afterMutation)
            || LOCALLY_BOUND_CLINICAL_TRANSITION_PATTERN.test(afterMutation);
        }
        const afterTarget = afterMutation.slice(localTarget[0].length);
        // A medical word elsewhere in the request cannot promote an explicitly
        // operational treatment object in this clause (batch/API/data, etc.).
        return !EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN.test(afterTarget);
      })()
    ))
    : [];
  const contextualOperationalMatches = [...text.matchAll(CONTEXTUAL_MEDICAL_MUTATION_PATTERN)].filter(match => (
    typeof match.index === 'number'
    && hasLocallyBoundOperationalTreatmentTarget(text.slice(match.index + match[0].length))
  ));
  const directClinicalProcedureMatches = contextualMedicalMutation
    ? [...text.matchAll(DIRECT_CLINICAL_PROCEDURE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (LOCALLY_BOUND_CLINICAL_PROCEDURE_PATTERN.test(
        text.slice(match.index + match[0].length),
      ) || LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN.test(
        text.slice(match.index + match[0].length),
      ))
    ))
    : [];
  const directClinicalPatientCareMatches = contextualMedicalMutation
    ? [...text.matchAll(DIRECT_CLINICAL_PATIENT_CARE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (LOCALLY_BOUND_CLINICAL_PATIENT_PATTERN.test(
        text.slice(match.index + match[0].length),
      ) || LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN.test(
        text.slice(match.index + match[0].length),
      ))
    ))
    : [];
  const candidates = [
    ...text.matchAll(pattern),
    ...text.matchAll(DIRECT_CLINICAL_PRESCRIPTION_MUTATION_PATTERN),
    ...contextualMedicalMatches,
    ...contextualOperationalMatches,
    ...directClinicalProcedureMatches,
    ...directClinicalPatientCareMatches,
    ...text.matchAll(DIRECT_RBAC_MUTATION_PATTERN),
    ...[...text.matchAll(MODAL_PASSIVE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && isAuthoritativeModalPassive(text, match.index, match[0].length)
    )),
    ...[...text.matchAll(FRENCH_REACTIVATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && isAuthoritativeFrenchReactivation(text, match.index, match[0])
    )),
    ...(structuredSensitive ? text.matchAll(STRUCTURED_SOURCE_TRANSFER_PATTERN) : []),
  ];
  const unique = new Map<number, { index: number; length: number }>();
  for (const match of candidates) {
    const index = match.index ?? -1;
    if (index < 0 || isNonAuthoritativeMutation(text, index, match[0].length)) continue;
    const previous = unique.get(index);
    if (!previous || match[0].length > previous.length) {
      unique.set(index, { index, length: match[0].length });
    }
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}

const MUTATION_SCOPE_BOUNDARY_PATTERN = /[!?;\n]+|\.(?![\p{L}\p{N}_])|,\s*(?:then|puis|ensuite)\b|\b(?:and then|then|but|puis|ensuite|mais|and|et)\b/giu;

const INTRINSIC_SENSITIVE_MUTATION_PATTERN = /^(?:grant|authorize|revoke|rotate|pay|accord|autoris|r[ée]voqu|pay)/iu;

const MUTATION_TARGET_PRONOUN_PATTERN = /^(?:\s*(?:them|it|those|these|cela|[çc]a)\b|\s*-\s*(?:les|la|le|l['’])\b|\s*(?:all|some|part)\s+(?:of\s+)?(?:them|it|those|these)\b|\s*(?:the\s+)?(?:(?:identified|reported|noted|remaining)\s+)?(?:issues?|problems?|findings?|gaps?)\b|\s*(?:une\s+partie|certain(?:e|es|s)?)\s+des?\s+(?:entr[ée]es|[ée]l[ée]ments|lignes|donn[ée]es)\b|\s*(?:les\s+)?(?:probl[èe]mes?|erreurs?|constats?|anomalies?|points?)\s+(?:relev[ée]s?|identifi[ée]s?|signal[ée]s?|trouv[ée]s?|restants?)\b)/iu;

const MUTATION_TARGET_PREVERBAL_PRONOUN_PATTERN = /(?:\b(?:les|la|le)|l['’])\s*$/iu;

const DOCUMENT_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:readme|docs?|documentation|report|summary|overview|typo|guide|runbook|article|blog post|plan|mockup|button|word|wording|spelling|label|translation|rapport|r[ée]sum[ée]|synth[èe]se|vue d['’]ensemble|coquille|billet|plan|maquette|bouton|mot|libell[ée]|orthographe|traduction)(?![\p{L}\p{N}_])/iu;

const LINGUISTIC_EDIT_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:word|wording|spelling|label|translation|mot(?!\s+de\s+passe)|libell[ée]|orthographe|traduction)(?![\p{L}\p{N}_])/iu;

const DOCUMENT_SUMMARY_TARGET_PATTERN = /(?<![\p{L}\p{N}_])(?:summary|overview|r[ée]sum[ée]|synth[èe]se|vue d['’]ensemble)(?![\p{L}\p{N}_])/iu;

const DOCUMENTED_CREDENTIAL_POLICY_PATTERN = /(?:\b(?:passwords?|credentials?|api keys?|access tokens?)\b[^.!?;\n]{0,48}\b(?:polic(?:y|ies)|rules?|requirements?|guidelines?|guidance)\b|\b(?:polic(?:y|ies)|rules?|requirements?|guidelines?|guidance)\b[^.!?;\n]{0,48}\b(?:passwords?|credentials?|api keys?|access tokens?)\b|\b(?:politique|r[èe]gles?|exigences?|consignes?)\b[^.!?;\n]{0,48}\b(?:mots?\s+de\s+passe|identifiants?|cl[ée]s?\s+api|jetons?\s+d['’]acc[èe]s)\b)/iu;

const DOCUMENT_EDIT_MUTATION_PATTERN = /^(?:update|fix|create|write|edit|draft|save|replace|eras|mettre\b|mets?\b|mettez\b|mettons\b|corrig|cr[ée]|[ée]cri|[ée]dit|r[ée]dig|sauvegard|rempla|effa)/iu;

const LOCAL_NON_OPERATIONAL_SENSITIVE_ARTIFACT_PATTERN = /(?<![\p{L}\p{N}_])(?:parsers?|parseurs?|unit\s+tests?|tests?\s+unitaires?|test\s+fixtures?|fixtures?|mocks?|stubs?|samples?|examples?|demos?|maquettes?|mockups?|css|styles?|styling|type\s+definitions?|definitions?\s+de\s+types?|sdk\s+types?|synthetic|synth[ée]tique|fake|factice)(?![\p{L}\p{N}_])/iu;

const LOCAL_ARTIFACT_EDIT_MUTATION_PATTERN = /^(?:fix|create|update|edit|rename|replace|format|style|enable|disable|corrig|cr[ée]|mets?\s+[àa]\s+jour|mettre\s+[àa]\s+jour|[ée]dit|renomm|rempla|format|stylis|active|d[ée]sactive)/iu;

const OPERATIONAL_SENSITIVE_EFFECT_PATTERN = /(?<![\p{L}\p{N}_])(?:pay|charge|debit|credit|transfer|wire|process(?:es|ed|ing)?\s+(?:a\s+)?payment|execute(?:s|d|ing)?\s+(?:a\s+)?transaction|submit(?:s|ted|ting)?\s+(?:a\s+)?payment|reset|rotate|revoke|grant|delete|remove|export|send|share|payer|facturer|d[ée]biter|cr[ée]diter|virer|transf[ée]rer|ex[ée]cuter\s+(?:une?\s+)?transaction|soumettre\s+(?:un\s+)?paiement|r[ée]initialiser|r[ée]voquer|accorder|supprimer|exporter|envoyer|partager)(?![\p{L}\p{N}_])/iu;

const STRUCTURED_SENSITIVE_TARGET_PATTERN = /\b(?:selected\s+(?:rows?|records?|items?|entries)|spreadsheet|workbook|worksheet|data\s*set|rows?|records?|entries|results?|data|tableur|classeur|feuille\s+de\s+calcul|lignes?\s+s[ée]lectionn[ée]es?|enregistrements?|jeu\s+de\s+donn[ée]es|entr[ée]es|r[ée]sultats?|donn[ée]es)\b/iu;

const READ_ONLY_OPERATION_START_PATTERN = /^\s*(?:(?:please|kindly|then|now|merci\s+de|veuillez|maintenant|puis|ensuite|(?:can|could|would)\s+you|peux-tu|pouvez-vous)\s+)?(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read|audite?|inspecte?|analyse|explique|r[ée]sume|v[ée]rifie|contr[ôo]le|lis|revois)(?![\p{L}\p{N}_])/iu;

const READ_ONLY_NOMINAL_OPERATION_START_PATTERN = /^\s*(?:(?:perform|conduct|run|effectue|fais|r[ée]alise)\s+)(?:(?:an?|the|une?|le|la)\s+)?(?:audit|inspection|review|check|analyse|revue|contr[ôo]le)(?![\p{L}\p{N}_])/iu;

const DECLARATIVE_CLAUSE_START_PATTERN = /^(?:(?:the|this|that|these|those|le|la|les|ce|cet|cette|ces|il|elle|ils|elles)\s+)[^.!?;\n]{0,100}\b(?:is|are|was|were|has|have|will|must|should|est|sont|[ée]tait|[ée]taient|a|ont|sera|seront|doit|doivent|devrait|devraient)\b/iu;

const MUTATION_MODIFIER_ONLY_START_PATTERN = /^(?:then|and\s+then|puis|ensuite|after|before|following|once|when|whenever|if|subject\s+to|pending|as\s+soon\s+as|provided\s+that|apr[èe]s|avant|lorsque|quand|si|d[èe]s\s+que|aussit[oô]t|une\s+fois|[àa]\s+la\s+suite\s+de|[àa]\s+condition\s+que|pourvu\s+que|sous\s+r[ée]serve\s+de|en\s+attendant)\b/iu;

const STRUCTURED_FIELD_DELIMITER_SOURCE = String.raw`(?:[:=]|\s+-\s+)`;

const ACTION_ONLY_PREFIX_PATTERN = new RegExp(
  String.raw`^\s*(?:[-*+•]\s*)?(?:(?:action|operation|op[ée]ration|command|commande|task|t[âa]che|[àa]\s+faire)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*)?$`,
  'iu',
);

const STRUCTURED_TARGET_FIELD_PATTERN = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:[-*+•]\s*)?(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*([^;\n]{1,200})`,
  'giu',
);

function normalizeClauseLead(text: string): string {
  return text.trimStart()
    .replace(/^(?:[,;:]\s*)+/u, '')
    .replace(/^(?:[-*+•]\s*)/u, '')
    .replace(new RegExp(
      String.raw`^(?:(?:action|operation|op[ée]ration|command|commande|task|t[âa]che|[àa]\s+faire)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*)`,
      'iu',
    ), '');
}

function operationStartsNearClauseBoundary(text: string): boolean {
  const normalized = normalizeClauseLead(text);
  const firstMutation = authoritativeMutationMatches(text)[0];
  return (firstMutation?.index ?? Number.POSITIVE_INFINITY) <= 24
    || READ_ONLY_OPERATION_START_PATTERN.test(normalized)
    || READ_ONLY_NOMINAL_OPERATION_START_PATTERN.test(normalized)
    || DECLARATIVE_CLAUSE_START_PATTERN.test(normalized)
    || /^(?:(?:the|this|that|a|le|ce|cet|cette|un)\s+)?(?:plan|document|report|rapport|text|texte|message|instruction|consigne)\b/iu.test(normalized);
}

function structuralDelimiterIndices(text: string, delimiter: string, from = 0): number[] {
  const indices: number[] = [];
  const quotePairs: Record<string, string> = { '"': '"', '“': '”', '«': '»', '`': '`' };
  let quoteClose: string | undefined;
  let escaped = false;
  let parenthesisDepth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoteClose) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && (quoteClose === '"' || quoteClose === '`')) {
        escaped = true;
      } else if (char === quoteClose) {
        quoteClose = undefined;
      }
      continue;
    }
    const closingQuote = quotePairs[char];
    if (closingQuote) {
      quoteClose = closingQuote;
      continue;
    }
    if (char === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (char === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (parenthesisDepth > 0 || char !== delimiter) continue;
    if (delimiter === '-' && !(/\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? ''))) {
      continue;
    }
    indices.push(index);
  }
  return indices;
}

function matchingParenthesisIndex(text: string): number {
  let depth = 0;
  const quotePairs: Record<string, string> = { '"': '"', '“': '”', '«': '»', '`': '`' };
  let quoteClose: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoteClose) {
      if (escaped) escaped = false;
      else if (char === '\\' && (quoteClose === '"' || quoteClose === '`')) escaped = true;
      else if (char === quoteClose) quoteClose = undefined;
      continue;
    }
    const closingQuote = quotePairs[char];
    if (closingQuote) {
      quoteClose = closingQuote;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function closedIntercalaryTails(text: string): string[] | undefined {
  const normalized = text.trimStart();
  if (normalized.startsWith('(')) {
    const closing = matchingParenthesisIndex(normalized);
    return closing < 0 ? undefined : [normalized.slice(closing + 1).trimStart()];
  }

  if (/^[—–-]/u.test(normalized)) {
    const opener = normalized[0]!;
    const closings = structuralDelimiterIndices(normalized, opener, 1);
    return closings.length === 0
      ? undefined
      : closings.map(closing => normalized.slice(closing + 1).trimStart());
  }

  if (!normalized.startsWith(',')) return undefined;
  const closings = structuralDelimiterIndices(normalized, ',', 1);
  return closings.length === 0
    ? undefined
    : closings.map(closing => normalized.slice(closing + 1).trimStart());
}

function plainConjunctionStartsAnotherOperation(text: string): boolean {
  const intercalaryTails = closedIntercalaryTails(text);
  if (intercalaryTails !== undefined) {
    // With nested comma/dash content, fail closed for safety: every plausible
    // closing mark must leave a new operation before the governing mutation is
    // detached from the target that follows the aside.
    return intercalaryTails.length > 0 && intercalaryTails.every(tail => (
      tail.length > 0 && operationStartsNearClauseBoundary(tail)
    ));
  }

  // A bare leading adjunct may have a single comma rather than paired marks:
  // "after review, verify ...". Inspect only what follows that comma. If it
  // does not start an operation, the text is still the target/modifier of the
  // governing mutation ("after review, the API account").
  const normalized = text.trimStart();
  const commaTails = structuralDelimiterIndices(normalized, ',')
    .map(comma => normalized.slice(comma + 1).trimStart());
  if (commaTails.length > 0 && commaTails.every(tail => (
    tail.length > 0 && operationStartsNearClauseBoundary(tail)
  ))) {
    return true;
  }
  return operationStartsNearClauseBoundary(text);
}

function mutationHasLocalTarget(text: string): boolean {
  let normalized = text.trim()
    .replace(/^(?:then|and\s+then|puis|ensuite)\b/iu, '')
    .replace(/^[\s.,:;…-]+/u, '')
    .trimStart();
  const intercalaryTails = closedIntercalaryTails(normalized);
  if (intercalaryTails !== undefined) {
    return intercalaryTails.some(tail => mutationHasLocalTarget(tail));
  }
  normalized = normalizeClauseLead(normalized)
    .replace(new RegExp(
      String.raw`^(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*`,
      'iu',
    ), '')
    .trim();
  return normalized.length > 0 && !MUTATION_MODIFIER_ONLY_START_PATTERN.test(normalized);
}

function implicitPreverbalSensitiveTarget(
  authorityText: string,
  scopeStart: number,
  beforeMutation: string,
  afterMutation: string,
): string | undefined {
  if (!ACTION_ONLY_PREFIX_PATTERN.test(beforeMutation)
    || !/^[\s.!?;:…]*$/u.test(afterMutation)) return undefined;
  const previousText = authorityText.slice(0, scopeStart).trim();
  const structuredTargets = [...previousText.matchAll(STRUCTURED_TARGET_FIELD_PATTERN)];
  const structuredTarget = structuredTargets.at(-1)?.[1]?.trim();
  const previousClause = previousText
    .split(/[.!?;\n]+/u)
    .map(part => part.trim())
    .filter(Boolean)
    .at(-1);
  if ((!structuredTarget && !previousClause) || (previousClause?.length ?? 0) > 200) return undefined;
  const candidate = structuredTarget ?? previousClause!.replace(new RegExp(
    String.raw`^(?:[-*+•]\s*)?(?:cible|target)\s*${STRUCTURED_FIELD_DELIMITER_SOURCE}\s*`,
    'iu',
  ), '');
  const riskCandidate = neutralizeNonCredentialObservationIdentifiers(candidate);
  return SENSITIVE_DOMAIN_PATTERN.test(riskCandidate)
    || DIRECT_RBAC_DOMAIN_PATTERN.test(riskCandidate)
    || PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(riskCandidate)
    || detectHighStakesEvidenceDomain(riskCandidate) !== undefined
    ? candidate
    : undefined;
}

function boundedReferentContext(text: string, maxChars = 8_192): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  return `${text.slice(0, headChars)}\n${text.slice(-tailChars)}`;
}

function scopedMutationRisk(
  authorityText: string,
  mutation: { index: number; length: number },
  sensitiveDomain: boolean,
  contextText: string,
  structuredSensitive: boolean,
  medicalDomain: boolean,
): { highRisk: boolean; criticalRisk: boolean } {
  let start = 0;
  let end = authorityText.length;
  for (const boundary of authorityText.matchAll(MUTATION_SCOPE_BOUNDARY_PATTERN)) {
    const boundaryIndex = boundary.index ?? 0;
    const boundaryEnd = boundaryIndex + boundary[0].length;
    if (boundaryEnd <= mutation.index) {
      start = boundaryEnd;
    } else if (boundaryIndex >= mutation.index + mutation.length) {
      const normalizedBoundary = boundary[0].trim().toLocaleLowerCase().replace(/^,\s*/, '');
      const tailStartsAnotherOperation = plainConjunctionStartsAnotherOperation(
        authorityText.slice(boundaryEnd),
      );
      // A sequencing adverb can modify the current verb ("Supprime ensuite le
      // compte") instead of introducing another operation. Keep its target in
      // the current scope unless the remainder actually starts a new action.
      if (['and', 'et', 'and then', 'then', 'puis', 'ensuite'].includes(normalizedBoundary)
        && !tailStartsAnotherOperation) {
        continue;
      }
      if (tailStartsAnotherOperation) {
        end = boundaryIndex;
        break;
      }
      // Newlines, semicolons and sentence punctuation can format the target
      // of the same command on a following line. Do not detach an incomplete
      // mutation from that target merely because prose punctuation intervenes.
      if (!mutationHasLocalTarget(authorityText.slice(
        mutation.index + mutation.length,
        boundaryIndex,
      ))) {
        continue;
      }
      end = boundaryIndex;
      break;
    }
  }
  const scope = authorityText.slice(start, end);
  const scopedRiskText = neutralizeNonCredentialObservationIdentifiers(scope);
  const mutationText = authorityText.slice(mutation.index, mutation.index + mutation.length);
  const beforeMutation = authorityText.slice(start, mutation.index);
  const after = authorityText.slice(mutation.index + mutation.length, end);
  const antecedent = authorityText.slice(Math.max(0, start - 180), start);
  // Runtime risk context puts the current direct turn first so it cannot be
  // truncated by history. A terse deictic mutation can therefore refer to a
  // sensitive objective immediately after its clause as well as before it.
  // Keep both ends of a bounded authenticated context. Long objectives often
  // place the concrete sensitive target after explanatory setup; a head-only
  // slice made "fix the reported issues" forget a trailing RBAC/credential
  // referent and silently lowered its safety tier.
  const referentContext = `${antecedent}\n${authorityText.slice(end, end + 180)}\n${boundedReferentContext(contextText)}`;
  const referentRiskContext = neutralizeNonCredentialObservationIdentifiers(referentContext);
  const implicitPreverbalTarget = implicitPreverbalSensitiveTarget(
    authorityText,
    start,
    beforeMutation,
    after,
  );
  const hasDeicticTarget = MUTATION_TARGET_PRONOUN_PATTERN.test(after)
    || MUTATION_TARGET_PREVERBAL_PRONOUN_PATTERN.test(beforeMutation);
  const targetReferentRiskContext = implicitPreverbalTarget
    ? neutralizeNonCredentialObservationIdentifiers(implicitPreverbalTarget)
    : referentRiskContext;
  const sensitiveAntecedent = (hasDeicticTarget || implicitPreverbalTarget !== undefined)
    && (SENSITIVE_DOMAIN_PATTERN.test(targetReferentRiskContext)
      || DIRECT_RBAC_DOMAIN_PATTERN.test(targetReferentRiskContext)
      || detectHighStakesEvidenceDomain(targetReferentRiskContext) !== undefined
      || PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(targetReferentRiskContext));
  const productionEnvironmentRisk = PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(scope)
    || FRENCH_PRODUCTION_PROMOTION_PATTERN.test(scope);
  const operationalTreatmentMutation = new RegExp(CONTEXTUAL_MEDICAL_MUTATION_PATTERN.source, 'iu').test(mutationText)
    && hasLocallyBoundOperationalTreatmentTarget(after);
  const medicalDomainRisk = !operationalTreatmentMutation
    && (detectHighStakesEvidenceDomain(scope) === 'medical'
      || medicalDomain && CONTEXTUAL_MEDICAL_TARGET_PATTERN.test(scope));
  const directLegalDocumentMutation = isDirectLegalDocumentMutation(scope);
  const targetBeforeQualifier = after.split(/\b(?:with|about|of|in|on|avec|sur|de|dans|concernant)\b/iu, 1)[0] ?? after;
  const documentTargetText = `${mutationText} ${targetBeforeQualifier}`;
  const explicitlyLinguisticEdit = LINGUISTIC_EDIT_TARGET_PATTERN.test(scope);
  const describesCredentialPolicy = DOCUMENT_SUMMARY_TARGET_PATTERN.test(scope)
    && DOCUMENTED_CREDENTIAL_POLICY_PATTERN.test(scope);
  const editsDocumentOnly = DOCUMENT_EDIT_MUTATION_PATTERN.test(mutationText)
    && DOCUMENT_TARGET_PATTERN.test(documentTargetText)
    && (explicitlyLinguisticEdit || describesCredentialPolicy || !CRITICAL_DOMAIN_PATTERN.test(scopedRiskText));
  const structuredSensitiveTarget = structuredSensitive
    && (STRUCTURED_SENSITIVE_TARGET_PATTERN.test(after) || hasDeicticTarget);
  // Merely notifying someone about a sensitive topic is still an external
  // mutation, but it is not the same as transferring a credential, payment,
  // or customer data. The longer transfer grammar above retains that tier.
  const communicationWithoutSensitivePayload = EXTERNAL_COMMUNICATION_MUTATION_PATTERN.test(mutationText)
    && !structuredSensitiveTarget && !directLegalDocumentMutation;
  // Sensitive vocabulary in a local parser, mock, fixture, UI field or type
  // definition is not itself an operational credential/payment/data action.
  // Keep real effects, confidential sources and production targets on the
  // sensitive tier while allowing Terra/Luna to handle bounded local code.
  const localNonOperationalSensitiveArtifact = !structuredSensitive
    && !productionEnvironmentRisk
    && !medicalDomainRisk
    && !DIRECT_RBAC_DOMAIN_PATTERN.test(scope)
    && LOCAL_ARTIFACT_EDIT_MUTATION_PATTERN.test(mutationText)
    && LOCAL_NON_OPERATIONAL_SENSITIVE_ARTIFACT_PATTERN.test(scope)
    && !OPERATIONAL_SENSITIVE_EFFECT_PATTERN.test(scope);
  const highRisk = !editsDocumentOnly && !communicationWithoutSensitivePayload
    && !localNonOperationalSensitiveArtifact && (
    SENSITIVE_DOMAIN_PATTERN.test(scopedRiskText)
      || DIRECT_RBAC_DOMAIN_PATTERN.test(scope)
      || directLegalDocumentMutation
      || medicalDomainRisk
      || productionEnvironmentRisk
      || (sensitiveDomain && INTRINSIC_SENSITIVE_MUTATION_PATTERN.test(mutationText))
      || sensitiveAntecedent
      || structuredSensitiveTarget
  );
  return {
    highRisk,
    criticalRisk: highRisk
      && (CRITICAL_DOMAIN_PATTERN.test(scopedRiskText)
        || (sensitiveAntecedent && CRITICAL_DOMAIN_PATTERN.test(targetReferentRiskContext))
        || productionEnvironmentRisk),
  };
}

export interface ObjectiveMutationRiskContext {
  /** Current authority; context outside this text may supply a deictic target but not a stale command. */
  authorityText?: string;
  /** Host-classified source sensitivity. */
  routingSensitivity?: SourceSensitivity;
}

export function classifyObjectiveMutationRisk(
  text: string,
  context: ObjectiveMutationRiskContext = {},
): ObjectiveMutationRiskClassification {
  const authorityText = context.authorityText ?? text;
  const exactAuditedPnsPostgresReadOnly = isAuditedPnsPostgresReadOnlyCommand(authorityText);
  const normalizedAuthority = exactAuditedPnsPostgresReadOnly
    ? { text: authorityText, audited: true }
    : neutralizeAuditedPnsPostgresReadOnlyProse(authorityText);
  const routingAuthorityText = normalizedAuthority.text;
  const normalizedContextText = authorityText === text
    ? routingAuthorityText
    : neutralizeAuditedPnsPostgresReadOnlyProse(text).text;
  const auditedPnsPostgresReadOnly = exactAuditedPnsPostgresReadOnly
    || normalizedAuthority.audited;
  const productionEnvironmentRisk = PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(text)
    || FRENCH_PRODUCTION_PROMOTION_PATTERN.test(text);
  const highStakesEvidenceDomain = detectHighStakesEvidenceDomain(text);
  const medicalDomainRisk = highStakesEvidenceDomain === 'medical';
  const legalDomainRisk = highStakesEvidenceDomain === 'legal';
  // Historical context can identify the legal subject of a deictic command,
  // but it must never manufacture current mutation authority. Bind the direct
  // mutation predicate to the same host-selected authority text as verbs.
  const directLegalDocumentMutation = isDirectLegalDocumentMutation(routingAuthorityText);
  const structuredSensitive = context.routingSensitivity === 'confidential'
    || context.routingSensitivity === 'restricted';
  const sensitiveDomain = SENSITIVE_DOMAIN_PATTERN.test(text)
    || DIRECT_RBAC_DOMAIN_PATTERN.test(text)
    || productionEnvironmentRisk
    || medicalDomainRisk
    || legalDomainRisk
    || directLegalDocumentMutation
    || structuredSensitive;
  const explicitReadOnly = EXPLICIT_READ_ONLY_PATTERN.test(routingAuthorityText);
  const readOnlyOperation = READ_ONLY_OPERATION_PATTERN.test(routingAuthorityText);
  const mutationMatches = exactAuditedPnsPostgresReadOnly
    ? []
    : authoritativeMutationMatches(routingAuthorityText, structuredSensitive);
  const mutationVerbPresent = mutationMatches.length > 0;
  // Read-only wording describes the audit/review step; it must never erase a
  // separate authoritative mutation elsewhere in the same request. Negated,
  // hypothetical, quoted and reported mutations are filtered per match above.
  const mutationRequested = mutationVerbPresent || directLegalDocumentMutation;
  const scopedRisks = mutationMatches.map(mutation => scopedMutationRisk(
    routingAuthorityText,
    mutation,
    sensitiveDomain,
    normalizedContextText,
    structuredSensitive,
    medicalDomainRisk,
  ));
  const highRisk = directLegalDocumentMutation
    || sensitiveDomain && scopedRisks.some(risk => risk.highRisk);
  const criticalRisk = highRisk && scopedRisks.some(risk => risk.criticalRisk);
  const readOnlyRisk = (auditedPnsPostgresReadOnly || sensitiveDomain
    && (explicitReadOnly || readOnlyOperation))
    && !highRisk;
  return { sensitiveDomain, mutationRequested, highRisk, criticalRisk, readOnlyRisk };
}
