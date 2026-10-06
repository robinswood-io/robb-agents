/**
 * Canonical grammar shared by the objective evidence gate and private model
 * router. Keeping the sources in one module prevents a safety-relevant RBAC
 * instruction from being gated by one layer but downgraded by another.
 *
 * These expressions intentionally describe complete role/access constructions.
 * A bare role noun is not a target: otherwise ordinary requests such as
 * "remove administrator typo" or "donne le rapport à l’administrateur" become
 * security mutations.
 */

export const ENGLISH_RBAC_ROLE_SOURCE = String.raw`(?:admins?|admin(?:istrator)?s?|owners?|maintainers?|editors?|viewers?|members?|superusers?)`;
export const FRENCH_RBAC_ROLE_SOURCE = String.raw`(?:admins?|administrat(?:eur|rice)s?|propri[ée]taires?|mainteneu(?:r|se)s?|[ée]dit(?:eur|rice)s?|lect(?:eur|rice)s?|membres?|superutilisat(?:eur|rice)s?)`;

const ENGLISH_DOCUMENTARY_OBJECT_SOURCE = String.raw`(?:(?:the|an?)\s+)?(?:word|label|text|copy|button|feature|dashboard|mockup|report|guide|note|typo|documentation)`;
const FRENCH_DOCUMENTARY_OBJECT_SOURCE = String.raw`(?:(?:le|la|les|l['’]|un|une|des)\s*)?(?:mot|libell[ée]|texte|copie|bouton|fonctionnalit[ée]|tableau\s+de\s+bord|maquette|rapport|guide|note|coquille|documentation)`;

const ENGLISH_RBAC_TEAM_SOURCE = String.raw`(?:(?:the\s+)?(?:admins?|admin(?:istrator)?s?|owners?|maintainers?|editors?|viewers?|members?|sre|sudoers?|[\p{L}\p{M}\p{N}_-]{2,32})\s+(?:group|team))`;
const FRENCH_RBAC_TEAM_SOURCE = String.raw`(?:(?:le|la|les)\s+|l['’]\s*)?(?:groupe|[ée]quipe)\s+(?:(?:des?|d['’])\s*)?(?:admins?|administrat(?:eur|rice)s?|propri[ée]taires?|mainteneu(?:r|se)s?|[ée]dit(?:eur|rice)s?|lect(?:eur|rice)s?|membres?|sre|sudoers?|[\p{L}\p{M}\p{N}_-]{2,32})`;
const ENGLISH_RBAC_ROLE_COLLECTION_SOURCE = String.raw`(?:admins?|admin(?:istrator)?s?|owners?|maintainers?|editors?|viewers?|members?|superusers?|sudoers?)`;
const FRENCH_RBAC_ROLE_COLLECTION_SOURCE = String.raw`(?:admins?|administrat(?:eur|rice)s?|propri[ée]taires?|mainteneu(?:r|se)s?|[ée]dit(?:eur|rice)s?|lect(?:eur|rice)s?|membres?|superutilisat(?:eur|rice)s?|sudoers?)`;

const ENGLISH_RBAC_RESOURCE_SOURCE = String.raw`(?:(?:the|an?)\s+)?(?:[\p{L}\p{M}\p{N}_'’.-]+\s+){0,4}(?:project|repository|repo|team|organization|organisation|account|resource|workspace|database|billing|portal|service|dashboard|console)`;
const FRENCH_RBAC_RESOURCE_SOURCE = String.raw`(?:(?:le|la|les|l['’]|un|une|des)\s+)?(?:[\p{L}\p{M}\p{N}_'’.-]+\s+){0,4}(?:projet|d[ée]p[oô]t|repository|repo|[ée]quipe|organisation|compte|ressource|espace\s+de\s+travail|base\s+de\s+donn[ée]es|facturation|portail|service)`;

const ENGLISH_RBAC_PRINCIPAL_SOURCE = String.raw`(?!(?:access|privileges?|rights?|roles?|permissions?|ownership)\b)(?:(?:the|an?)\s+)?[\p{L}\p{M}\p{N}_@.'’+-]+(?:\s+(?!(?:access|privileges?|rights?|roles?|permissions?|ownership)\b)[\p{L}\p{M}\p{N}_@.'’+-]+){0,4}`;
const FRENCH_RBAC_PRINCIPAL_SOURCE = String.raw`(?!(?:acc[èe]s|droits?|privil[èe]ges?|r[oô]les?|permissions?|propri[ée]t[ée])\b)(?:(?:le|la|l['’]|un|une)\s+)?[\p{L}\p{M}\p{N}_@.'’+-]+(?:\s+(?!(?:acc[èe]s|droits?|privil[èe]ges?|r[oô]les?|permissions?|propri[ée]t[ée])\b)[\p{L}\p{M}\p{N}_@.'’+-]+){0,4}`;

const ENGLISH_ROLE_PRIVILEGE_TARGET_SOURCE = String.raw`(?:(?:${ENGLISH_RBAC_ROLE_SOURCE}|read|write|sudo|billing)\s+(?:access|privileges?|rights?|roles?|permissions?)|${ENGLISH_RBAC_RESOURCE_SOURCE}\s+access|(?:access|privileges?|rights?|roles?|permissions?)\s+(?:(?:of|for|to)\s+)?(?:an?\s+)?(?:${ENGLISH_RBAC_ROLE_SOURCE}|read|write|sudo|billing)|${ENGLISH_RBAC_ROLE_SOURCE}\s+accounts?)`;
const FRENCH_ROLE_PRIVILEGE_TARGET_SOURCE = String.raw`(?:(?:droits?|acc[èe]s|privil[èe]ges?|r[oô]les?|permissions?)\s+(?:(?:de|des|pour)\s+|d['’]\s*)?(?:l['’]\s*)?(?:en\s+)?(?:lecture|[ée]criture|facturation|admin|${FRENCH_RBAC_ROLE_SOURCE}|sudo)s?|(?:admin|${FRENCH_RBAC_ROLE_SOURCE}|sudo|facturation)s?\s+(?:droits?|acc[èe]s|privil[èe]ges?|r[oô]les?|permissions?)|comptes?\s+${FRENCH_RBAC_ROLE_SOURCE})`;
const ENGLISH_OWNERSHIP_TARGET_SOURCE = String.raw`(?:${ENGLISH_RBAC_RESOURCE_SOURCE}\s+ownership|ownership\s+(?:of|for|to)\s+${ENGLISH_RBAC_RESOURCE_SOURCE})`;
const FRENCH_OWNERSHIP_TARGET_SOURCE = String.raw`(?:${FRENCH_RBAC_RESOURCE_SOURCE}\s+propri[ée]t[ée]|propri[ée]t[ée]\s+(?:du|de\s+la|des|de\s+l['’])\s+${FRENCH_RBAC_RESOURCE_SOURCE})`;

export const DIRECT_RBAC_PRIVILEGE_TARGET_SOURCE = String.raw`(?:${ENGLISH_ROLE_PRIVILEGE_TARGET_SOURCE}|${FRENCH_ROLE_PRIVILEGE_TARGET_SOURCE}|${ENGLISH_RBAC_TEAM_SOURCE}|${FRENCH_RBAC_TEAM_SOURCE}|${ENGLISH_OWNERSHIP_TARGET_SOURCE}|${FRENCH_OWNERSHIP_TARGET_SOURCE})`;

export const ENGLISH_RBAC_ASSIGNMENT_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b|(?:an?\s+|the\s+)?${ENGLISH_RBAC_ROLE_SOURCE}\b)(?:(?!\b(?:for|about|of|with|in)\b)[^.!?;\n]){1,80}\s+(?:(?:as|to)\s+)?(?:an?\s+)?${ENGLISH_RBAC_ROLE_SOURCE}(?:\s+role)?`;
export const FRENCH_RBAC_ASSIGNMENT_TAIL_SOURCE = String.raw`\s+(?!${FRENCH_DOCUMENTARY_OBJECT_SOURCE}\b|(?:(?:le|la|les|une?)\s+|l['’]\s*)?${FRENCH_RBAC_ROLE_SOURCE}\b)(?:(?!\b(?:pour|sur|dans)\b)[^.!?;\n]){1,80}\s+(?:(?:comme|en\s+tant\s+qu['’]?|aux?|en)\s+)?(?:r[oô]le\s+)?${FRENCH_RBAC_ROLE_SOURCE}`;

const ENGLISH_RBAC_MEMBERSHIP_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b)${ENGLISH_RBAC_PRINCIPAL_SOURCE}\s+(?:to|into|in)\s+(?:${ENGLISH_RBAC_TEAM_SOURCE}|${ENGLISH_RBAC_ROLE_COLLECTION_SOURCE})`;
const ENGLISH_RBAC_REMOVAL_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b)${ENGLISH_RBAC_PRINCIPAL_SOURCE}\s+from\s+(?:(?:an?\s+)?${ENGLISH_RBAC_ROLE_SOURCE}|${ENGLISH_RBAC_TEAM_SOURCE}|${ENGLISH_RBAC_ROLE_COLLECTION_SOURCE})`;
const FRENCH_RBAC_MEMBERSHIP_TAIL_SOURCE = String.raw`\s+(?!${FRENCH_DOCUMENTARY_OBJECT_SOURCE}\b)${FRENCH_RBAC_PRINCIPAL_SOURCE}\s+(?:dans|aux?|[àa])\s+(?:${FRENCH_RBAC_TEAM_SOURCE}|${FRENCH_RBAC_ROLE_COLLECTION_SOURCE})`;
const FRENCH_RBAC_REMOVAL_TAIL_SOURCE = String.raw`\s+(?!${FRENCH_DOCUMENTARY_OBJECT_SOURCE}\b)${FRENCH_RBAC_PRINCIPAL_SOURCE}\s+(?:(?:(?:du|de\s+la|des)\s+|de\s+l['’]\s*)(?:r[oô]le\s+)?${FRENCH_RBAC_ROLE_SOURCE}|(?:(?:du|de\s+la|des)\s+|de\s+l['’]\s*)(?:${FRENCH_RBAC_TEAM_SOURCE}|${FRENCH_RBAC_ROLE_COLLECTION_SOURCE}))`;

export const DIRECT_RBAC_ELEVATION_TAIL_SOURCE = String.raw`\s+[^.!?;\n]{1,80}\s+(?:(?:to\s+)?superuser|(?:au\s+rang\s+de\s+|comme\s+)?superutilisat(?:eur|rice))`;

const ENGLISH_GENERIC_ACCESS_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b)${ENGLISH_RBAC_PRINCIPAL_SOURCE}(?:['’]s)?\s+(?:access\s+(?:to|on)\s+${ENGLISH_RBAC_RESOURCE_SOURCE}|permissions?\s+to\s+(?:manage|administer|edit|view|own)\s+${ENGLISH_RBAC_RESOURCE_SOURCE})`;
const ENGLISH_ACCOUNT_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b)${ENGLISH_RBAC_PRINCIPAL_SOURCE}(?:['’]s)?\s+(?:${ENGLISH_RBAC_ROLE_SOURCE}\s+)?accounts?`;
const ENGLISH_RBAC_MANAGED_OBJECT_SOURCE = String.raw`(?:${ENGLISH_RBAC_RESOURCE_SOURCE}|users?|roles?|members?|billing)`;
const ENGLISH_MANAGEMENT_TAIL_SOURCE = String.raw`\s+(?!${ENGLISH_DOCUMENTARY_OBJECT_SOURCE}\b)${ENGLISH_RBAC_PRINCIPAL_SOURCE}\s+to\s+(?:access|manage|administer|edit|view|own)\s+${ENGLISH_RBAC_MANAGED_OBJECT_SOURCE}`;
const ENGLISH_OWNERSHIP_TRANSFER_TAIL_SOURCE = String.raw`\s+(?:${ENGLISH_OWNERSHIP_TARGET_SOURCE}|(?:(?:the|an?)\s+)?ownership)\s+to\s+${ENGLISH_RBAC_PRINCIPAL_SOURCE}`;
const FRENCH_GENERIC_ACCESS_TAIL_SOURCE = String.raw`(?:\s+(?:[àa]\s+)?${FRENCH_RBAC_PRINCIPAL_SOURCE}\s+(?:(?:l['’]|un\s+|une\s+)?acc[èe]s\s+(?:[àa]|au|aux|sur)\s+${FRENCH_RBAC_RESOURCE_SOURCE}|(?:une?\s+)?permissions?\s+(?:de|pour)\s+(?:g[ée]rer|administrer|modifier|consulter|poss[ée]der)\s+${FRENCH_RBAC_RESOURCE_SOURCE})|\s+(?:l['’]|un\s+|une\s+)?acc[èe]s\s+(?:d['’]|de\s+)${FRENCH_RBAC_PRINCIPAL_SOURCE}\s+(?:[àa]|au|aux|sur)\s+${FRENCH_RBAC_RESOURCE_SOURCE})`;
const FRENCH_ACCOUNT_TAIL_SOURCE = String.raw`\s+(?:(?:le|la|un|une)\s+)?comptes?\s+(?:(?:d['’]|de\s+)${FRENCH_RBAC_PRINCIPAL_SOURCE}(?:\s+${FRENCH_RBAC_ROLE_SOURCE})?|${FRENCH_RBAC_ROLE_SOURCE}\s+(?:d['’]|de\s+)${FRENCH_RBAC_PRINCIPAL_SOURCE})`;
const FRENCH_RBAC_MANAGED_OBJECT_SOURCE = String.raw`(?:${FRENCH_RBAC_RESOURCE_SOURCE}|utilisat(?:eur|rice)s?|r[oô]les?|membres?|facturation)`;
const FRENCH_MANAGEMENT_TAIL_SOURCE = String.raw`\s+(?:[àa]\s+)?${FRENCH_RBAC_PRINCIPAL_SOURCE}\s+(?:[àa]|de)\s+(?:acc[ée]der\s+[àa]|g[ée]rer|administrer|modifier|consulter|poss[ée]der)\s+(?:(?:le|la|les|l['’])\s*)?${FRENCH_RBAC_MANAGED_OBJECT_SOURCE}`;
const FRENCH_OWNERSHIP_TRANSFER_TAIL_SOURCE = String.raw`\s+(?:${FRENCH_OWNERSHIP_TARGET_SOURCE}|(?:la\s+)?propri[ée]t[ée])\s+[àa]\s+${FRENCH_RBAC_PRINCIPAL_SOURCE}`;
const ENGLISH_PRIVILEGE_TAIL_SOURCE = String.raw`(?:[^.!?;\n]{1,120}(?:${DIRECT_RBAC_PRIVILEGE_TARGET_SOURCE})|${ENGLISH_GENERIC_ACCESS_TAIL_SOURCE}|${ENGLISH_ACCOUNT_TAIL_SOURCE}|${ENGLISH_MANAGEMENT_TAIL_SOURCE}|${ENGLISH_OWNERSHIP_TRANSFER_TAIL_SOURCE})`;
const FRENCH_PRIVILEGE_TAIL_SOURCE = String.raw`(?:[^.!?;\n]{1,120}(?:${DIRECT_RBAC_PRIVILEGE_TARGET_SOURCE})|${FRENCH_GENERIC_ACCESS_TAIL_SOURCE}|${FRENCH_ACCOUNT_TAIL_SOURCE}|${FRENCH_MANAGEMENT_TAIL_SOURCE}|${FRENCH_OWNERSHIP_TRANSFER_TAIL_SOURCE})`;

const ENGLISH_RBAC_ASSIGNMENT_ACTION_SOURCE = String.raw`(?:make|makes|made|making|nam(?:e|es|ed|ing)|appoint(?:s|ed|ing)?|promot(?:e|es|ed|ing)|demot(?:e|es|ed|ing)|add(?:s|ed|ing)?|set(?:s|ting)?|chang(?:e|es|ed|ing)|invit(?:e|es|ed|ing)|convert(?:s|ed|ing)?)`;
const FRENCH_RBAC_ASSIGNMENT_ACTION_SOURCE = String.raw`(?:nomm(?:er|e(?:s|z)?|ons?|[ée](?:e|es|s)?)|promouv(?:oir|ant|ez|ons)|r[ée]trograd(?:er|e(?:s|z)?|ons?|ent)|d[ée]sign(?:er|e(?:s|z)?|ons?|[ée](?:e|es|s)?)|d[ée]fin(?:ir|is|it|issez|issons|issent)|ajout(?:er|e(?:s|z)?|ons?|[ée](?:e|es|s)?)|pass(?:er|e(?:s|z)?|ons?|[ée](?:e|es|s)?)|rend(?:re|s|ez|ons|ent|u(?:e|es|s)?)|invit(?:er|e(?:s|z)?|ons?|ent)|chang(?:er|e(?:s|z)?|ons?|ent)|convert(?:ir|is|issez|issons|issent))`;
const ENGLISH_RBAC_MEMBERSHIP_ACTION_SOURCE = String.raw`(?:add(?:s|ed|ing)?|includ(?:e|es|ed|ing)|invit(?:e|es|ed|ing))`;
const FRENCH_RBAC_MEMBERSHIP_ACTION_SOURCE = String.raw`(?:ajout(?:er|e(?:s|z)?|ons?)|inclu(?:re|s|e|es|ez|ons|ent)|invit(?:er|e(?:s|z)?|ons?|ent)|mettre|mets?|mettez|mettons|mettent)`;
const ENGLISH_RBAC_REMOVAL_ACTION_SOURCE = String.raw`(?:demot(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|exclud(?:e|es|ed|ing))`;
const FRENCH_RBAC_REMOVAL_ACTION_SOURCE = String.raw`(?:r[ée]trograd(?:er|e(?:s|z)?|ons?|ent)|retir(?:er|e(?:s|z)?|ons?)|exclu(?:re|s|e|es|ez|ons|ent))`;
const ENGLISH_RBAC_PRIVILEGE_ACTION_SOURCE = String.raw`(?:assign(?:s|ed|ing)?|add(?:s|ed|ing)?|giv(?:e|es|ing|en)|gave|grant(?:s|ed|ing)?|revok(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|elevat(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|disabl(?:e|es|ed|ing)|activat(?:e|es|ed|ing)|deactivat(?:e|es|ed|ing)|suspend(?:s|ed|ing)?|allow(?:s|ed|ing)?|authoriz(?:e|es|ed|ing)|permit(?:s|ted|ting)?|den(?:y|ies|ied|ying)|block(?:s|ed|ing)?|provid(?:e|es|ed|ing)|transfer(?:s|red|ring)?)`;
const FRENCH_RBAC_PRIVILEGE_ACTION_SOURCE = String.raw`(?:attribu(?:er|e(?:s|z)?|ons?)|assign(?:er|e(?:s|z)?|ons?)|ajout(?:er|e(?:s|z)?|ons?)|donn(?:er|e(?:s|z)?|ons?)|accord(?:er|e(?:s|z)?|ons?)|octroi(?:e|es|ez|ent)|octroy(?:er|ez|ons)|r[ée]voqu(?:er|e(?:s|z)?|ons?)|retir(?:er|e(?:s|z)?|ons?)|supprim(?:er|e(?:s|z)?|ons?)|(?:mettre|mets?|mettez|mettons)|[ée]l[èe]v(?:er|e(?:s|z)?|ons?)|activ(?:er|e(?:s|z)?|ons?)|d[ée]sactiv(?:er|e(?:s|z)?|ons?)|suspend(?:re|s|ez|ons|ent)|autoris(?:er|e(?:s|z)?|ons?)|interdi(?:re|s|t|sez|sons)|refus(?:er|e(?:s|z)?|ons?)|permet(?:tre|s|tez|tons)|bloqu(?:er|e(?:s|z)?|ons?|ent)|transf[éèe]r(?:er|e(?:s|z)?|ons?))`;

export const DIRECT_RBAC_ASSIGNMENT_PHRASE_SOURCE = String.raw`(?:${ENGLISH_RBAC_ASSIGNMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])${ENGLISH_RBAC_ASSIGNMENT_TAIL_SOURCE}|${FRENCH_RBAC_ASSIGNMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])${FRENCH_RBAC_ASSIGNMENT_TAIL_SOURCE}|${ENGLISH_RBAC_MEMBERSHIP_ACTION_SOURCE}(?![\p{L}\p{N}_])${ENGLISH_RBAC_MEMBERSHIP_TAIL_SOURCE}|${FRENCH_RBAC_MEMBERSHIP_ACTION_SOURCE}(?![\p{L}\p{N}_])${FRENCH_RBAC_MEMBERSHIP_TAIL_SOURCE}|${ENGLISH_RBAC_REMOVAL_ACTION_SOURCE}(?![\p{L}\p{N}_])${ENGLISH_RBAC_REMOVAL_TAIL_SOURCE}|${FRENCH_RBAC_REMOVAL_ACTION_SOURCE}(?![\p{L}\p{N}_])${FRENCH_RBAC_REMOVAL_TAIL_SOURCE}|(?:elevat(?:e|es|ed|ing)|[ée]l[èe]v(?:er|e(?:s|z)?|ons?))(?![\p{L}\p{N}_])${DIRECT_RBAC_ELEVATION_TAIL_SOURCE})`;

export const DIRECT_RBAC_PRIVILEGE_PHRASE_SOURCE = String.raw`(?:${ENGLISH_RBAC_PRIVILEGE_ACTION_SOURCE}(?![\p{L}\p{N}_])${ENGLISH_PRIVILEGE_TAIL_SOURCE}|${FRENCH_RBAC_PRIVILEGE_ACTION_SOURCE}(?![\p{L}\p{N}_])${FRENCH_PRIVILEGE_TAIL_SOURCE})`;

export const DIRECT_RBAC_MUTATION_ACTION_SOURCE = String.raw`(?<![\p{L}\p{N}_])(?:${ENGLISH_RBAC_ASSIGNMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${ENGLISH_RBAC_ASSIGNMENT_TAIL_SOURCE})|${FRENCH_RBAC_ASSIGNMENT_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${FRENCH_RBAC_ASSIGNMENT_TAIL_SOURCE})|${ENGLISH_RBAC_MEMBERSHIP_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${ENGLISH_RBAC_MEMBERSHIP_TAIL_SOURCE})|${FRENCH_RBAC_MEMBERSHIP_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${FRENCH_RBAC_MEMBERSHIP_TAIL_SOURCE})|${ENGLISH_RBAC_REMOVAL_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${ENGLISH_RBAC_REMOVAL_TAIL_SOURCE})|${FRENCH_RBAC_REMOVAL_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${FRENCH_RBAC_REMOVAL_TAIL_SOURCE})|(?:elevat(?:e|es|ed|ing)|[ée]l[èe]v(?:er|e(?:s|z)?|ons?))(?![\p{L}\p{N}_])(?=${DIRECT_RBAC_ELEVATION_TAIL_SOURCE})|${ENGLISH_RBAC_PRIVILEGE_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${ENGLISH_PRIVILEGE_TAIL_SOURCE})|${FRENCH_RBAC_PRIVILEGE_ACTION_SOURCE}(?![\p{L}\p{N}_])(?=${FRENCH_PRIVILEGE_TAIL_SOURCE}))`;
