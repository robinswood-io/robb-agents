import { trimTrailingCharacters } from "../../../utils/string-boundaries.ts";
import type { HighStakesEvidenceDomain, SecurityDocumentationProvider } from './contracts.ts';

export const EVIDENCE_TOOL_PATTERN = /(?:search|query|fetch|browser|read|open|download|source|research|(?:^|__|_)(?:get|list|inspect|status|check)(?:__|_|$))/i;

export const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;

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

export const SOURCE_INSPECTION_TOOL_PATTERN = /(?:fetch|browser|(?:^|__|_)open(?:__|_|$)|web__run)/i;

export const FIRST_PARTY_SOURCE_TOOLS: Record<HighStakesEvidenceDomain, RegExp | undefined> = {
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

export function objectiveSecurityDocumentationProviders(text: string): SecurityDocumentationProvider[] {
  const normalized = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const providers: SecurityDocumentationProvider[] = [];
  if (/\b(?:docker|containers?|conteneurs?|bind[ -]?mounts?|montages?\s+bind)\b/.test(normalized)) providers.push('docker');
  if (/\b(?:github|secret[ -]?scanning|code[ -]?scanning|dependabot)\b/.test(normalized)) providers.push('github');
  if (/\b(?:microsoft|m365|office\s*365|azure|entra|graph\s+api|microsoft\s+graph)\b/.test(normalized)) providers.push('microsoft');
  if (/\b(?:openai|chatgpt|model\s+spec|agents?\s+(?:security|policy|safety)|securite\s+des?\s+agents?)\b/.test(normalized)) providers.push('openai');
  if (/\b(?:systemd|systemctl|service\s+units?|unit\s+files?|unites?\s+systemd)\b/.test(normalized)) providers.push('systemd');
  return providers;
}

export function objectiveBusinessSourceVendors(text: string): Array<'cerfrance' | 'silae'> {
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
export function sourceObservationSucceeded(result: string): boolean {
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
export function hasOfficialSourceUrl(
  result: string,
  domain: HighStakesEvidenceDomain,
  businessSourceVendors: readonly ('cerfrance' | 'silae')[],
  securityDocumentationProviders: readonly SecurityDocumentationProvider[],
): boolean {
  return [...result.matchAll(/https?:\/\/[^\s<>"'`\\]+/gi)]
    .some(match => isOfficialSourceUrl(
      trimTrailingCharacters(match[0], '),.;'), domain, businessSourceVendors, securityDocumentationProviders,
    ));
}

/** Inspect request targets, never prompt/body text that can merely mention a source. */
export function targetsOfficialSource(
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
