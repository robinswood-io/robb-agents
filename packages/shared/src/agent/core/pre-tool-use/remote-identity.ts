import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';
import { boundedSoftwareTargetOccurrenceIsNegated } from './software-scope.ts';

export function objectiveNamesRemoteEndpoint(
  endpoint: string,
  objectiveSegments: readonly string[],
): boolean {
  const canonicalEndpoint = endpoint.toLowerCase();
  if (!isCanonicalRemoteEndpoint(canonicalEndpoint)) return false;
  return objectiveSegments.some(segment => {
    // Extract the same ASCII-only identifier grammar from human prose. This
    // keeps case-insensitive aliases and sentence punctuation usable while a
    // distinct Unicode spelling or a longer dotted hostname cannot silently
    // authorize the configured endpoint.
    const identifiers: readonly string[] = segment.toLowerCase().match(
      /[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g,
    ) ?? [];
    return identifiers.includes(canonicalEndpoint);
  });
}

export function isCanonicalRemoteEndpoint(endpoint: string): boolean {
  // Connector aliases are authority-bearing identifiers, not prose. Validate
  // the raw value before doing any human-text normalization: NFKD folding must
  // not turn a distinct Unicode alias (`pñs`, full-width `ｐｎｓ`) into the
  // authorized ASCII target. Separators remain available for dotted/qualified
  // aliases, but may not absorb sentence punctuation such as a trailing dot.
  return /^[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}$/.test(endpoint);
}

function structuredRemoteReadChannelSignals(segment: string): {
  normalized: string;
  namesStructuredChannel: boolean;
  excludesSsh: boolean;
  apiOnly: boolean;
} {
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const namesStructuredChannel = /\brbw[-_ ]?servers?\b|\bssh\s+structure\b|\bstructured\s+ssh\b/u.test(normalized);
  // A human may explicitly forbid local/native/CLI SSH while requiring the
  // audited rbw-servers transport. Remove only that fully qualified negative
  // clause before checking broad SSH prohibitions; an unqualified `sans SSH`
  // or `do not use SSH` remains authoritative and blocks the exception.
  const sshExclusionText = namesStructuredChannel
    ? normalized.replace(
       /\b(?:(?:sans|without|no)\s+(?:(?:local(?:e)?|nati(?:f|ve)|direct|cli)\s+ssh|ssh\s+(?:local(?:e)?|nati(?:f|ve)|direct|cli))|(?:do\s+not|don't)\s+(?:use\s+)?(?:(?:local|native|direct|cli)\s+ssh|ssh\s+(?:local|native|direct|cli))|(?:n[' ]?utilis(?:e|er|ez)\s+(?:pas|plus|jamais)|ne\s+(?:pas|plus|jamais)\s+utilis(?:e|er|ez))\s+(?:(?:le\s+)?(?:ssh\s+(?:local|natif|direct|cli)|(?:local|natif|direct|cli)\s+ssh)))\b/gu,
       ' ',
     )
     : normalized;
  const excludesSsh = /\b(?:sans|without|no)\s+(?:(?:le|the)\s+)?(?:ssh|rbw[-_ ]?servers?)\b/u.test(sshExclusionText)
    || /\b(?:do\s+not|don't|n[' ]?utilis(?:e|er|ez)\s+(?:pas|plus|jamais)|ne\s+(?:pas|plus|jamais)\s+utilis(?:e|er|ez))\b[^.!?;\n]{0,40}\b(?:ssh|rbw[-_ ]?servers?)\b/u.test(sshExclusionText);
  const apiOnly = /\b(?:(?:via|par|avec|using|through)\s+)?(?:(?:l[' ]|the\s+))?api\s+(?:uniquement|seulement|only)\b/u.test(normalized)
    || /\b(?:uniquement|seulement|only)\s+(?:via|par|avec|using|through)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized)
    || /\b(?:utilise|utiliser|utilisez|use|using)\s+(?:desormais\s+|now\s+)?(?:uniquement|seulement|only|exclusively)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized)
    || /\b(?:passe|passer|passez|go)\s+(?:desormais\s+|now\s+)?(?:uniquement\s+|only\s+)?(?:par|via|through)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized);
  return { normalized, namesStructuredChannel, excludesSsh, apiOnly };
}

export function explicitlyAuthorizesStructuredRemoteReadChannel(segment: string): boolean {
  const { normalized, excludesSsh, apiOnly } = structuredRemoteReadChannelSignals(segment);
  if (excludesSsh || apiOnly) return false;
  return /\b(?:ssh|rbw[-_ ]?servers?)\b/u.test(normalized)
    || /\b(?:sur|via|on|through)\s+(?:(?:le|the)\s+)?(?:serveurs?|servers?)\b/u.test(normalized);
}


function normalizedRemoteProjectIdentity(value: string): string {
  const withoutDigestOrTag = value.split('@', 1)[0]!.replace(/:[^/:]+$/, '');
  let identity = (withoutDigestOrTag.split('/').filter(Boolean).at(-1) ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  // These suffixes describe the role/artifact family rather than a sibling
  // project. Strip them repeatedly so `sample-app` binds to endpoint `sample`,
  // while `pns-other` remains distinct and fails closed.
  let previous = '';
  while (identity !== previous) {
    previous = identity;
    identity = identity.replace(/(?:application|service|server|worker|generator|gen|app)$/u, '');
  }
  return identity;
}

export function remoteProjectTargetMatchesEndpoint(target: string, endpoint: string): boolean {
  return normalizedRemoteProjectIdentity(target)
    === endpoint.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function explicitDockerRegistryFromImageTarget(target: string): string | undefined {
  const firstSlash = target.indexOf('/');
  if (firstSlash <= 0) return undefined;
  const registry = target.slice(0, firstSlash).toLowerCase();
  // Docker treats the first component as a registry only when it is an exact
  // hostname/IP (or localhost), optionally followed by a literal port.
  const match = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)(?::([1-9]\d{0,4}))?$/u.exec(registry);
  if (!match || !registry.includes('.') && !registry.includes(':') && registry !== 'localhost') {
    return undefined;
  }
  const port = match[2] === undefined ? undefined : Number(match[2]);
  return port !== undefined && port > 65_535 ? undefined : registry;
}

export function objectiveExplicitlyAuthorizesDockerRegistry(
  registry: string,
  segment: string,
): boolean {
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const declaration = /\b(?:registre|registry)\s+(?:(?:docker|exacte?)\s+){0,2}(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::[1-9]\d{0,4})?)/gu;
  for (const match of normalized.matchAll(declaration)) {
    const candidate = match[1];
    if (!candidate || candidate !== registry || match.index === undefined) continue;
    const relativeIndex = match[0].lastIndexOf(candidate);
    const index = match.index + relativeIndex;
    if (relativeIndex >= 0
      && !boundedSoftwareTargetOccurrenceIsNegated(
        normalized,
        index,
        candidate.length,
      )) return true;
  }
  return false;
}

export function staticSourceInspectionRemotePath(command: string): string | undefined {
  const match = /(?:^|\s)(\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044})(?:\s|$)/u.exec(command);
  return match?.[1];
}

export function boundedStructuredRemoteExecutionInput(input: Record<string, unknown>): boolean {
  if (Object.keys(input).some(key => ![
    'server', 'command', 'cwd', 'timeout', '_displayName', '_intent',
  ].includes(key))) return false;
  return input["timeout"] === undefined
    || (typeof input["timeout"] === 'number' && Number.isInteger(input["timeout"])
      && input["timeout"] >= 1 && input["timeout"] <= 300_000);
}
