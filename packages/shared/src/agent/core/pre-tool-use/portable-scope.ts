import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';

export const PORTABLE_SESSION_PATH_TOKEN = '{{SESSION_PATH}}';

export const BOUNDED_OSS_ATOMIC_WRITE_TOOL = 'mcp__rbw-agents-oss__oss_write_file';

export function pathUsesSymbolicLinkBelowBoundary(path: string, boundary: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedBoundary = resolve(boundary);
  const canonicalBoundary = realpathSync.native(resolvedBoundary);
  const canonicalPath = realpathSync.native(resolvedPath);
  const lexicallyWithin = (target: string, base: string): boolean => {
    const candidate = relative(base, target);
    return candidate === '' || !candidate.startsWith('..') && !isAbsolute(candidate);
  };
  const inspectionBoundary = lexicallyWithin(resolvedPath, resolvedBoundary)
    ? resolvedBoundary
    : canonicalBoundary;
  const inspectionPath = lexicallyWithin(resolvedPath, inspectionBoundary)
    ? resolvedPath
    : canonicalPath;
  if (!lexicallyWithin(inspectionPath, inspectionBoundary)) return true;
  let current = inspectionPath;
  while (current !== inspectionBoundary) {
    if (lstatSync(current).isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return lstatSync(inspectionBoundary).isSymbolicLink();
}

export function explicitPortableSessionDataRoots(segment: string): string[] {
  const roots = [...segment.matchAll(/`(\{\{SESSION_PATH\}\}\/data\/[^`\r\n]+)`/gu)]
    .map(match => match[1])
    .filter((value): value is string => {
      if (typeof value !== 'string'
        || !value.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/data/`)) return false;
      const suffix = value.slice(PORTABLE_SESSION_PATH_TOKEN.length);
      return posix.normalize(suffix) === suffix
        && !/[$`*?[\]{}~\\\0\r\n]/u.test(suffix)
        && !suffix.split('/').some((part, index) => index > 0
          && (!part || part === '.' || part === '..'));
    });
  return [...new Set(roots)];
}

/** A fully restated recovery contract can appear as inert payload inside a
 * report, example or analysis request. Those wrappers must not become fresh
 * upload authority merely because the embedded text contains every required
 * endpoint, path and mutation verb. Keep direct top-level contracts valid. */
export function isQuotedOrReportedBoundedSoftwareContract(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (/```|~~~/u.test(trimmed)
    || /^[^\S\r\n]*>/mu.test(trimmed)
    || /^(?:[«“„])/u.test(trimmed)) return true;

  const normalized = normalizeUserInstructionForChannelMatch(trimmed);
  const resumeMarkers = [...normalized.matchAll(/\[robb-resume:[^\]]+\]/gu)];
  if (resumeMarkers.length > 1 || (resumeMarkers[0]?.index ?? 0) > 0) return true;
  const unwrapped = normalized.replace(/^\[robb-resume:[^\]]+\]\s*/u, '');

  return /^(?:(?:analyse|analyze|review|audite|audit|evalue|evaluate|explique|explain|resume|summarize)\b.{0,160}\b(?:prompt|instruction|texte|text|demande|request)\b|(?:(?:le|ce|un|the|this|a)\s+)?(?:rapport|report|exemple|example|sample|citation|quote|documentation|reference)\b|(?:voici|here is|ci dessous|below)\b.{0,120}\b(?:exemple|example|sample|prompt|instruction|citation|quote|rapport|report)\b|(?:a titre d exemple|pour reference(?: uniquement)?|for reference(?: only)?|quoted text|texte cite)\b)/u.test(unwrapped);
}
