import { isExplicitReadOnlyReview } from "../objective-contract.ts";
import type { DelegatedReviewRequest, HostParentReviewContract } from './host-scope.ts';

/** Top-level JSON objects only, respecting quotes and escapes. No evaluation. */
export function requestObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0; let start = -1; let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth) quoted = true;
    else if (char === '{') { if (!depth) start = index; depth++; }
    else if (char === '}' && depth && --depth === 0) {
      try {
        // User templates commonly spell a boolean as true|false or bool. Only
        // these non-JSON tokens in a value position are normalized.
        const value = JSON.parse(text.slice(start, index + 1)
          .replace(/:\s*(?:true\s*\|\s*false|bool(?:ean)?)(?=\s*[,}])/gi, ':false'));
        if (value && typeof value === 'object' && !Array.isArray(value)) objects.push(value);
      } catch { /* Other prose/braces are not review contracts. */ }
    }
  }
  return objects;
}

interface ExplicitTargetMention {
  value: string;
  start: number;
  end: number;
}

/** Collect concrete resource-shaped tokens independently of their introducer.
 * A reviewer target still needs the explicit grammar in reviewTarget(), but a
 * second bare path/URL cannot be silently discarded after the first target. */
function explicitTargetMentions(text: string): ExplicitTargetMention[] {
  const mentions: ExplicitTargetMention[] = [];
  for (const match of text.matchAll(
    /\bhttps?:\/\/[^\s,;"<>]+|\b[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:\/(?!\/)[^\s,;"<>]+|(?<![a-zA-Z0-9_.:/-])\/(?!\/)[^\s,;"<>]+/gi,
  )) {
    const raw = match[0]!;
    const value = raw.replace(/[.)\]}]+$/, '');
    mentions.push({ value, start: match.index!, end: match.index! + raw.length });
  }
  return mentions;
}

export function reviewTarget(text: string, sourceSlugs: readonly string[] = []): Pick<DelegatedReviewRequest, 'target' | 'remote'> | undefined {
  const targets = [...text.matchAll(/\b(?:cible|target|worktree|dans|in|cwd|d[ée]p[oô]t|repository|repo)(?:\s*[:=]\s*|\s+)(https?:\/\/[^\s,;"<>]+|\/(?!\/)[^\s,;"<>]+|[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:\/(?!\/)[^\s,;"<>]+)/gi)]
    .map(match => match[1]!.replace(/[.)]+$/, ''));
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length !== 1 || uniqueTargets[0]!.length > 2_048) return undefined;
  const value = uniqueTargets[0]!;
  // URI schemes are resources, never rbw server aliases. Only the deliberately
  // narrower alias:/absolute/path form participates in remote qualification.
  const httpUrl = /^https?:\/\//i.test(value);
  if (/^https?:/i.test(value) && !httpUrl) return undefined;
  const qualified = httpUrl
    ? null
    : /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):(\/.*)$/.exec(value);
  const servers = new Set([...text.matchAll(/\bserver\s*=\s*([^\s,;"<>]*)/gi)].map(match => match[1]!.replace(/[.)]+$/, '')));
  if (qualified) servers.add(qualified[1]!);
  // Ordinary prose such as "code source disponible" is not a connector
  // declaration. Keep only the explicit transport wording used by the request.
  const sources = new Set([...text.matchAll(/\b(?:via|avec|et|sur)\s+(?:la\s+)?source\s+([^\s,;"<>]*)/gi)].map(match => match[1]!.replace(/[.)]+$/, '')));
  if (servers.size === 1 && !sources.size && sourceSlugs.includes('rbw-servers')) sources.add('rbw-servers');
  if (!servers.size && !sources.size) return { target: value };
  // This connector's actual receipts attest the server/cwd/command input
  // schema. Unknown connectors or incomplete identities stay unqualified.
  if (servers.size !== 1 || sources.size !== 1 || !sources.has('rbw-servers')
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test([...servers][0]!)) return undefined;
  const target = qualified?.[2] ?? value;
  if (!target.startsWith('/')) return undefined;
  return { target, remote: { source: 'rbw-servers', server: [...servers][0]! } };
}

/** Resolve a single inspection identity before the child prompt is wrapped.
 * This extracts only a target/version from the parent text; it grants no action
 * authority and the child receives a constant read-only reviewer procedure. */
export function deriveHostDelegatedReviewSingleTarget(
  prompt: string,
  sourceSlugs: readonly string[] = [],
): HostParentReviewContract['singleTarget'] {
  const explicitTargets = explicitTargetMentions(prompt);
  if (new Set(explicitTargets.map(item => item.value)).size !== 1) return undefined;
  const target = reviewTarget(prompt, sourceSlugs);
  if (!target) return undefined;
  const folded = prompt.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const foldedTargets = explicitTargetMentions(folded);
  // match.index uses UTF-16 code-unit offsets; split('') preserves those
  // offsets even when the preceding prompt contains astral characters.
  const targetMasked = folded.split('');
  for (const mention of foldedTargets) {
    for (let index = mention.start; index < mention.end; index++) {
      if (targetMasked[index] !== '\n') targetMasked[index] = ' ';
    }
  }
  const revisionText = targetMasked.join('');
  const signal = /\b(?:commits?|revisions?|versions?|sha(?:-?(?:1|256))?s?|heads?)\b|\b[a-f0-9]{7,40}\b/i;
  if (!signal.test(revisionText)) return target;

  // Admit one deliberately small positive grammar only. The phrase must be a
  // complete clause or immediately follow the one target token, and it must
  // end that clause. Negations, host/runtime comparisons, plural forms,
  // hash-first prose and additional versions therefore fail structurally.
  const canonical = /\b(?:(?:a\s+la|at)\s+)?(commit|revision|sha(?:-?1)?|head)(?:\s+(?:cible|target|attendu(?:e)?|expected|requested))?\s*[:=]?\s*([a-f0-9]{7,40})\b/gi;
  const accepted: Array<{ start: number; end: number; revision: string }> = [];
  for (const match of revisionText.matchAll(canonical)) {
    const start = match.index!;
    const end = start + match[0].length;
    const clauseStart = Math.max(
      revisionText.lastIndexOf('.', start - 1), revisionText.lastIndexOf('!', start - 1),
      revisionText.lastIndexOf('?', start - 1), revisionText.lastIndexOf(';', start - 1),
      revisionText.lastIndexOf('\n', start - 1),
    ) + 1;
    const endings = ['.', '!', '?', ';', '\n']
      .map(delimiter => revisionText.indexOf(delimiter, end))
      .filter(index => index >= 0);
    const clauseEnd = endings.length ? Math.min(...endings) : revisionText.length;
    const precedingTarget = [...foldedTargets]
      .reverse()
      .find(item => item.start >= clauseStart && item.end <= start);
    const beginsClause = !revisionText.slice(clauseStart, start).trim();
    const followsTarget = precedingTarget !== undefined
      && /^[\s,:\-—]*$/u.test(revisionText.slice(precedingTarget.end, start));
    const endsClause = !revisionText.slice(end, clauseEnd).trim();
    if (endsClause && (beginsClause || followsTarget)) {
      accepted.push({ start, end, revision: match[2]!.toLowerCase() });
    }
  }
  if (accepted.length !== 1) return undefined;
  const remaining = revisionText.split('');
  for (let index = accepted[0]!.start; index < accepted[0]!.end; index++) {
    if (remaining[index] !== '\n') remaining[index] = ' ';
  }
  if (signal.test(remaining.join(''))) return undefined;
  return { ...target, revision: accepted[0]!.revision };
}

/** Qualify the full explicit review instruction; templates never create read-only authority. */
export function isBoundReadOnlyReviewScope(text: string): boolean {
  if (isExplicitReadOnlyReview(text)) return true;
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (/\b(?:lecture\s+seule|read[- ]only)\s+(?:si\s+possible|if\s+possible)\b/.test(folded)) return false;
  const reviewer = /^(?:tu\s+es\s+(?:(?:le|la|un|une)\s+)?|agis\s+comme\s+(?:(?:le|la|un|une)\s+)?)(?:contre-)?(?:reviewer|reviseur|reviseuse|relecteur|relectrice)\b/.test(folded);
  const readingInstruction = /(?:^|[.!?\n])\s*(?:verifi(?:e|ez)|inspect(?:e|ez))\s+(?:independamment\s*,?\s*)?(?:en\s+lecture\s+seule)\b/.test(folded);
  if (!reviewer || !readingInstruction) return false;
  // Use the existing full-request mutation rejection. Prefixing is permitted
  // only after the explicit role AND reading instruction were identified.
  if (/\b(?:apport(?:e|er|ez)\s+(?:les|des)\s+(?:corrections?|modifications?)|(?:les|des)\s+(?:corrections?|modifications?)\s+doivent\s+etre\s+appliquees?)\b/.test(folded)) return false;
  return isExplicitReadOnlyReview(`Revue independante en lecture seule. ${text}`);
}
