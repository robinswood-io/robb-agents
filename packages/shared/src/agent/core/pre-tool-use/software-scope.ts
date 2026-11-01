import { trimTrailingCharacters } from "../../../utils/string-boundaries.ts";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';

const BOUNDED_SOFTWARE_REMOTE_PATH_PATTERN = /\/(?:srv|opt|var|etc|workspace|app|apps)(?:\/[A-Za-z0-9_@%+=:.-]+)+/g;

const BOUNDED_SOFTWARE_MUTATION_SOURCE = String.raw`(?:apply|applique|appliquer|correct|corrige|corriger|fix|implement|impl[ée]mente|impl[ée]menter|modify|modifie|modifier|replace|remplace|remplacer|update|mets?\s+[àa]\s+jour|upload|uploade|uploader|deploy|d[ée]ploie|d[ée]ployer|redeploy|red[ée]ploie|red[ée]ployer|rebuild|reconstruis?|start|d[ée]marre|d[ée]marrer|restart|red[ée]marre|red[ée]marrer)`;

const BOUNDED_SOFTWARE_MUTATION_PATTERN = new RegExp(
  String.raw`\b${BOUNDED_SOFTWARE_MUTATION_SOURCE}\b`,
  'iu',
);

export const BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN = /\b(?:read[- ]only|lecture\s+seule)\b/iu;

export const BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN = /(?:\b(?:sans|without)\s+(?:aucune?|any)\s+(?:modifications?|mutations?|[ée]critures?|writes?|changes?)\b|\b(?:aucune?|no)\s+(?:(?:nouvelle|nouvel|nouvelles|nouveaux|autre|autres|further|additional)\s+)?(?:modifications?|mutations?|[ée]critures?|writes?|changes?)\b|\b(?:ne|n['’])\s+(?:modifi\w*|chang\w*|[ée]cri\w*|t[ée]l[ée]vers\w*|upload\w*|d[ée]ploi\w*)\s+(?:(?:absolument|plus|pas|jamais)\s+)?rien\b|\b(?:do\s+not|don't|never)\s+(?:modify|change|write|upload|deploy)\s+(?:anything|anything\s+else)\b)/iu;

const BOUNDED_SOFTWARE_OBSERVATION_PHASE_PATTERN = /\b(?:inspect|inspecte|inspecter|diagnos|diagnostique|diagnostiquer|analyse|analyze|observe|check|verifie|v[ée]rifie|valide|validate|lis|lire|read)\w*\b/iu;

export const BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN = /\b(?:cible|cibler|target|scope|p[ée]rim[eè]tre)\b/iu;

export const BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN = /\b(?:serveur|server|h[oô]te|host)\s+[a-z0-9]/iu;

interface BoundedSoftwareRemoteRootOccurrence {
  path: string;
  index: number;
  rawLength: number;
  negated: boolean;
}

export interface BoundedSoftwareRemoteEndpointOccurrence {
  endpoint: string;
  index: number;
  end: number;
}

export interface BoundedSoftwareRemoteTargetTuple {
  endpoint: string;
  root: string;
}

export function boundedSoftwareInstructionPhases(segment: string): string[] {
  const coarsePhases = segment.split(
    /[!?;\n]+|[.](?=\s|$)|,\s*(?=(?:puis|ensuite|then|afterwards)\b)|\b(?:puis|then)\b/iu,
  ).map(phase => phase.trim()).filter(Boolean);
  const mutationTransition = new RegExp(
    String.raw`\b(?:(?:et|and)(?:\s+(?:ensuite|afterwards))?|avant\s+de|before)\s+(?=\b${BOUNDED_SOFTWARE_MUTATION_SOURCE}\b)`,
    'giu',
  );
  return coarsePhases.flatMap((phase) => {
    const parts: string[] = [];
    let cursor = 0;
    for (const match of phase.matchAll(mutationTransition)) {
      if (match.index === undefined) continue;
      const nextStart = match.index + match[0].length;
      // Split only when the tail independently carries positive mutation
      // authority. A negative tail such as “and do not modify anything” is a
      // revocation, not a phase transition that may revive upload authority.
      if (!explicitlyAuthorizesBoundedSoftwareMutationClause(phase.slice(nextStart))) continue;
      const before = phase.slice(cursor, match.index).trim();
      if (before) parts.push(before);
      cursor = nextStart;
    }
    const tail = phase.slice(cursor).trim();
    if (tail) parts.push(tail);
    return parts;
  });
}

export function boundedSoftwareMutationIsRevoked(phases: readonly string[]): boolean {
  if (!phases.some(explicitlyAuthorizesBoundedSoftwareMutationClause)) return true;
  return phases.some((phase) => {
    const readOnly = BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN.test(phase);
    const explicitRevocation = BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN.test(phase);
    if (!readOnly && !explicitRevocation) return false;
    const scopedObservation = BOUNDED_SOFTWARE_OBSERVATION_PHASE_PATTERN.test(phase)
      && !explicitlyAuthorizesBoundedSoftwareMutationClause(phase);
    // “Inspect first in read-only mode, then fix” constrains only the earlier
    // observation phase. A final “verify read-only” is likewise a verification
    // constraint, not a retroactive cancellation of the requested mutation.
    if (scopedObservation) return false;
    return true;
  });
}

export function boundedSoftwareTargetOccurrenceIsNegated(
  text: string,
  start: number,
  length: number,
): boolean {
  const before = normalizeUserInstructionForChannelMatch(
    text.slice(Math.max(0, start - 96), start),
  );
  const after = normalizeUserInstructionForChannelMatch(
    text.slice(start + length, start + length + 64),
  );
  return /(?:\b(?:not|no|never|without|except|excluding|exclude|forbidden|outside|hors|sauf|sans|pas|jamais|ni|exclu|interdit)\b|\b(?:do\s+not|don't)\b|\b(?:ne|n')\b[^,.!?;\n]{0,48}\b(?:pas|jamais|ni)\b)[^,.!?;\n]{0,48}$/u.test(before)
    || /^(?:(?:server|serveur|root|racine)\s+)?(?:(?:is|est|reste|doit\s+etre|must\s+be)\s+)?(?:explicitement\s+|explicitly\s+)?(?:excluded|exclu(?:e|es|s)?|forbidden|interdit(?:e|es|s)?|hors\s+perimetre|out\s+of\s+scope)\b/u.test(after);
}

export function explicitlyAuthorizesBoundedSoftwareMutationClause(clause: string): boolean {
  if (!BOUNDED_SOFTWARE_MUTATION_PATTERN.test(clause)) return false;
  const normalized = normalizeUserInstructionForChannelMatch(clause);
  return !/\b(?:do\s+not|don't|never|sans)\b[^.!?;\n]{0,120}\b(?:apply|correct|fix|implement|modify|replace|update|upload|deploy|redeploy|rebuild|start|restart)\b/u.test(normalized)
    && !/\b(?:ne|n)\b[^.!?;\n]{0,120}\b(?:pas|jamais|plus|rien)\b/u.test(normalized)
    && !/\b(?:apply|applique\w*|correct|corrig\w*|fix|implement\w*|modify|modifi\w*|replace|remplac\w*|update|upload\w*|deploy\w*|deploi\w*|redeploy\w*|redeploi\w*|rebuild|reconstrui\w*|start|demarr\w*|restart|redemarr\w*)\b[^.!?;\n]{0,24}\b(?:nothing|rien|pas|jamais)\b/u.test(normalized);
}

function boundedSoftwareRemotePathIsDirectlyQuoted(
  segment: string,
  index: number,
  rawLength: number,
): boolean {
  const before = segment[index - 1];
  const after = segment[index + rawLength];
  return (before === '`' && after === '`')
    || (before === '"' && after === '"')
    || (before === "'" && after === "'")
    || (before === '«' && after === '»')
    || (before === '“' && after === '”')
    || (before === '‘' && after === '’');
}

export function explicitBoundedSoftwareRemoteRootOccurrences(
  segment: string,
): BoundedSoftwareRemoteRootOccurrence[] {
  const occurrences: BoundedSoftwareRemoteRootOccurrence[] = [];
  for (const match of segment.matchAll(BOUNDED_SOFTWARE_REMOTE_PATH_PATTERN)) {
    const rawPath = match[0];
    const index = match.index;
    if (index === undefined) continue;
    // A period/comma at an unquoted prose boundary terminates the locator; the
    // same character inside a directly quoted path remains part of the path.
    // Do not alter the accepted path alphabet or normalize punctuation inside
    // the locator itself.
    const path = boundedSoftwareRemotePathIsDirectlyQuoted(
      segment,
      index,
      rawPath.length,
    ) ? rawPath : trimTrailingCharacters(rawPath, '.,');
    const parts = path.split('/').slice(1);
    if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) continue;
    occurrences.push({
      path,
      index,
      rawLength: rawPath.length,
      negated: boundedSoftwareTargetOccurrenceIsNegated(segment, index, rawPath.length),
    });
  }
  return occurrences;
}

export function explicitBoundedSoftwareRemoteRoots(segment: string): {
  authorized: string[];
  excluded: string[];
} {
  const authorized: string[] = [];
  const excluded: string[] = [];
  for (const occurrence of explicitBoundedSoftwareRemoteRootOccurrences(segment)) {
    (occurrence.negated ? excluded : authorized).push(occurrence.path);
  }
  return { authorized, excluded };
}

export function remotePathIsWithinRoot(remotePath: string, root: string): boolean {
  return remotePath === root || remotePath.startsWith(`${root}/`);
}
