import { isReadOnlyRegisteredShellObservation } from "../../agent/core/registered-observation.ts";
import { AUDITED_PNS_POSTGRES_EXTRA_CAPABILITY_PATTERN, AUDITED_PNS_POSTGRES_FORM_CUE_PATTERN, AUDITED_PNS_POSTGRES_MUTATING_SQL_PATTERN, AUDITED_PNS_POSTGRES_OBSERVATION_CUE_PATTERN, AUDITED_PNS_POSTGRES_PREFIX_PATTERN, AUDITED_PNS_POSTGRES_PROSE_BASE_PATTERN, AUDITED_PNS_POSTGRES_PROSE_QUERY_PATTERN, AUDITED_PNS_POSTGRES_UNVALIDATED_SQL_PATTERN, AUDITED_PNS_POSTGRES_WRAPPER_PATTERN, NON_CREDENTIAL_OBSERVATION_IDENTIFIER_PATTERN, SENSITIVE_OBSERVATION_IDENTIFIER_QUALIFIER_PATTERN } from './patterns.ts';

export interface ObjectiveMutationRiskClassification {
  sensitiveDomain: boolean;
  mutationRequested: boolean;
  highRisk: boolean;
  criticalRisk: boolean;
  readOnlyRisk: boolean;
}

export function isAuditedPnsPostgresReadOnlyCommand(text: string): boolean {
  const command = text.trim();
  return command.length > 0
    && AUDITED_PNS_POSTGRES_PREFIX_PATTERN.test(command)
    && isReadOnlyRegisteredShellObservation(command);
}

function maskRoutingTextMatch(match: string): string {
  return ' '.repeat(match.length);
}

export function neutralizeNonCredentialObservationIdentifiers(text: string): string {
  if (SENSITIVE_OBSERVATION_IDENTIFIER_QUALIFIER_PATTERN.test(text)) return text;
  return text.replace(
    NON_CREDENTIAL_OBSERVATION_IDENTIFIER_PATTERN,
    match => maskRoutingTextMatch(match),
  );
}

export function neutralizeAuditedPnsPostgresReadOnlyProse(
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
