import { isUnknownArray } from '../../../utils/json.ts';

export function commandFromInput(input: Record<string, unknown>): string | undefined {
  return [input["command"], input["cmd"], input["script"]].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

const NON_BROWSER_CHANNEL_PATTERN = /(?:\bapi\b|\bconnect(?:eur|or)s?\b|\bdatabase\b|\bdb\b|\bbase\s+de\s+donnees?\b|\bsql\b|\bssh\b|\bserveurs?\b|\bservers?\b)/u;

const BROWSER_INTERFACE_PATTERN = /(?:\bbrowsers?\b|\bnavigateurs?\b|\binterfaces?\b|\bui\b)/u;

const BROWSER_LIFECYCLE_COMMANDS = new Set(['--help', '-h', 'help', 'release', 'close', 'hide']);

export function normalizeUserInstructionForChannelMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/gu, "'")
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isBrowserLifecycleCommand(command: unknown): boolean {
  if (isUnknownArray(command)) {
    if (command.length < 1 || command.length > 2
      || !command.every((part: unknown): part is string => typeof part === 'string')) return false;
    const operation = command[0]?.trim().toLowerCase();
    if (!operation || !BROWSER_LIFECYCLE_COMMANDS.has(operation)) return false;
    return command.length === 1 || operation === 'release' || operation === 'close' || operation === 'hide';
  }
  if (typeof command !== 'string') return false;

  const trimmed = command.trim();
  if (/^(?:--help|-h|help)$/iu.test(trimmed)) return true;
  // Keep this exception deliberately narrower than the browser executor. A
  // batch or malformed command stays subject to the channel guard.
  return /^(?:release|close|hide)(?:\s+(?:[^\s;'"\r\n]+|"[^"\r\n;]*"|'[^'\r\n;]*'))?$/iu.test(trimmed);
}

function preserveIndicesWithoutApiInterfaces(normalized: string): string {
  return normalized.replace(
    /\b(?:(?:api|connect(?:eur|or)s?|database|base\s+de\s+donnees?|serveurs?|servers?)\s+interfaces?|interfaces?\s+(?:api|connect(?:eur|or)s?|database|serveurs?|servers?))\b/gu,
    match => ' '.repeat(match.length),
  );
}

function isNegatedDirectiveStart(value: string, index: number): boolean {
  const prefix = value.slice(Math.max(0, index - 48), index);
  return /(?:\bdo\s+not|\bdon't|\bnot|\bnever|\bwithout|\bavoid|\bpas|\bne\s+(?:pas|jamais|plus)|\bn'|\b(?:evite|eviter)(?:\s+d[' ]?)?)\s*$/u.test(prefix);
}

function lastPatternMatchIndex(
  value: string,
  patterns: readonly RegExp[],
  rejectNegatedStart = false,
): number {
  let latest = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of value.matchAll(matcher)) {
      const index = match.index ?? -1;
      if (index < 0 || rejectNegatedStart && isNegatedDirectiveStart(value, index)) continue;
      latest = Math.max(latest, index);
    }
  }
  return latest;
}

function lastBrowserHandoffIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const purpose = /(?:\bauth(?:entication|entification)?\b|\bauthentifi(?:cation|e|er|ez)?\b|\blog[ -]?in\b|\bsign[ -]?in\b|\bconnexion\b|\bconnect(?:e|er|ez|ion)?\b|\bidentifi(?:cation|e|er|ez)\b|\bhandoff\b|\bpass(?:e|er|ez)?\s+(?:moi\s+)?la\s+main\b|\brepr(?:ends?|endre)\s+la\s+main\b|\bvalidation\s+visuelle?\b|\bcontrole\s+visuel\b|\bverif(?:y|ication|ier|ie|iez)\s+visuell?e?\b|\bvisually\b|\bvisual\s+(?:check|validation|verification)\b)/u;
  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  const openPattern = /\b(?:open|reopen|ouvre|ouvrir|rouvre|rouvrir|reouvre|reouvrir)\b/gu;
  let latest = -1;
  for (const match of browserText.matchAll(openPattern)) {
    const index = match.index ?? -1;
    if (index < 0 || isNegatedDirectiveStart(browserText, index)) continue;
    const tail = browserText.slice(index, index + 180);
    const purposeMatch = purpose.exec(tail);
    if (!purposeMatch) continue;
    const directTarget = new RegExp(`^[^.!?;]{0,60}\\b${browser}\\b`, 'u').test(tail);
    const contextualTarget = /^[^.!?;]{0,24}\b(?:it|this|le|la|lui|celui-ci|celle-ci)\b/u.test(tail);
    // Rank the complete scoped directive at its purpose, not merely at its
    // opening verb. Otherwise the nested phrase “browser only” starts a few
    // characters later and incorrectly wins as unrestricted browser authority.
    if (directTarget || contextualTarget) {
      latest = Math.max(latest, index + purposeMatch.index);
    }
  }
  return latest;
}

function lastBrowserExclusionIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  const target = `(?:(?:(?:a|an|the|le|la|les|un|une)\\s+|l[' ])?)${browser}\\b`;
  return lastPatternMatchIndex(browserText, [
    new RegExp(`\\b(?:non|not|no)\\s+(?:pas\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:never|without|avoid)\\s+(?:(?:use|using|open|opening)\\s+)?${target}`, 'gu'),
    new RegExp(`\\bsans\\s+(?:(?:utiliser|ouvrir|passer\\s+par)\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:evite|eviter)\\s+(?:(?:d[' ]?)?(?:utiliser|ouvrir)\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:au\\s+lieu\\s+de|plutot\\s+que|rather\\s+than|instead\\s+of)\\s+(?:(?:using|use|opening|open|utiliser|ouvrir)\\s+)?${target}`, 'gu'),
    new RegExp(`\\bpas\\s+(?:de\\s+)?${target}`, 'gu'),
    new RegExp(`(?:\\bne\\s+(?:pas|jamais|plus)\\s+(?:utiliser|ouvrir)|\\bn'(?:utilise|ouvre)\\s+(?:pas|jamais|plus))\\s+${target}`, 'gu'),
    new RegExp(`\\bdo\\s+not\\s+(?:use|open)\\s+${target}`, 'gu'),
    new RegExp(`\\bdon't\\s+(?:use|open)\\s+${target}`, 'gu'),
    new RegExp(`\\b${browser}\\b\\s+(?:(?:est|is)\\s+)?(?:strictement\\s+)?(?:interdit|interdite|forbidden|proscrite?|exclu(?:e|s)?|unavailable|broken|inaccessible|down|indisponible|casse|hors\\s+service)\\b`, 'gu'),
    new RegExp(`\\b${browser}\\b\\s+(?:is\\s+not\\s+available|ne\\s+(?:fonctionne|marche)\\s+pas)\\b`, 'gu'),
  ]);
}

function lastBrowserRequestIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  let latest = lastPatternMatchIndex(browserText, [
    new RegExp(`\\b(?:via|through|dans|in|avec|using)\\s+(?:le\\s+|la\\s+|the\\s+|l[' ])?${browser}\\b`, 'gu'),
    new RegExp(`\\b${browser}\\s+(?:uniquement|seulement|only|exclusively)\\b`, 'gu'),
  ], true);
  const actionPattern = /\b(?:open|reopen|use|using|ouvre|ouvrir|rouvre|rouvrir|reouvre|reouvrir|utilise|utiliser|utilisez)\b/gu;
  for (const match of browserText.matchAll(actionPattern)) {
    const index = match.index ?? -1;
    if (index < 0 || isNegatedDirectiveStart(browserText, index)) continue;
    const tail = browserText.slice(index, index + 80);
    if (new RegExp(`^[^.!?;]{0,60}\\b${browser}\\b`, 'u').test(tail)) {
      latest = Math.max(latest, index);
    }
  }
  return latest;
}

function lastNonBrowserChannelIndex(normalized: string): number {
  const channel = '(?:api|connect(?:eur|or)s?|database|db|base\\s+de\\s+donnees?|sql|ssh|serveurs?|servers?)';
  const structuredChannel = NON_BROWSER_CHANNEL_PATTERN.test(normalized)
    ? lastPatternMatchIndex(normalized, [
    new RegExp(`\\b(?:via|through|par|avec|using)\\s+(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:utilise|utiliser|utilisez|use|using)\\s+(?:(?:uniquement|seulement|directement|only|exclusively|directly)\\s+)?(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:call|invoke|query|appelle|appeler|appelez|invoque|invoquer|interroge|interroger)\\s+(?:l[' ]|the\\s+)?${channel}\\b(?:\\s+(?:directly|directement))?`, 'gu'),
    new RegExp(`\\b(?:execute|run|executer|executez|lance|lancer|lancez)\\b[^.!?;]{0,40}\\b(?:on|via|through|sur|par)\\s+(?:le\\s+|the\\s+)?(?:serveurs?|servers?|ssh)\\b`, 'gu'),
    new RegExp(`\\b(?:passe|passer|passez|go)\\s+(?:uniquement\\s+|only\\s+)?(?:par|through|via)\\s+(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:concentre(?:-toi|\\s+toi)?|focus)\\s+(?:uniquement\\s+|only\\s+)?(?:sur|on)\\s+(?:(?:la|the)\\s+)?(?:partie\\s+|side\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b${channel}\\s+(?:uniquement|seulement|only|exclusively)\\b`, 'gu'),
      ], true)
    : -1;
  // A closure may deliberately allow either a local read or an equivalent
  // structured observation without naming the connector. "Structured" is a
  // machine-readable channel here, not permission to substitute a browser UI.
  const boundedLocalOrStructuredRead = lastPatternMatchIndex(normalized, [
    /\b(?:seulement|uniquement|only)\s+(?:une?\s+|an?\s+)?(?:observation|lecture|inspection|read)\s+(?:locale?|local)\s+(?:ou|or)\s+(?:structuree?|structured)(?:\s+(?:strictement|strictly))?\s+(?:en\s+)?(?:lecture\s+seule|read\s+only)\b/gu,
    /\b(?:only|seulement|uniquement)\s+(?:a\s+|une?\s+)?(?:local|locale?)\s+(?:or|ou)\s+(?:structured|structuree?)\s+(?:strictly\s+|strictement\s+)?(?:read\s+only|lecture\s+seule)\s+(?:observation|read|inspection|lecture)\b/gu,
  ], true);
  return Math.max(structuredChannel, boundedLocalOrStructuredRead);
}

export type BrowserChannelDirective = 'non-browser' | 'browser-handoff' | 'browser' | 'none';

function classifyBrowserChannelDirective(instruction: string): BrowserChannelDirective {
  const normalized = normalizeUserInstructionForChannelMatch(instruction);
  const candidates: Array<{ index: number; priority: number; directive: BrowserChannelDirective }> = [
    { index: lastNonBrowserChannelIndex(normalized), priority: 0, directive: 'non-browser' },
    { index: lastBrowserExclusionIndex(normalized), priority: 1, directive: 'non-browser' },
    // A positive combined request such as "use API and browser" wins a tie.
    { index: lastBrowserRequestIndex(normalized), priority: 2, directive: 'browser' },
    // Authentication handoff and final visual validation are deliberately
    // narrower than operational browser authority. They may open/read the UI,
    // but must never enable a generic API-to-browser fallback or browser
    // mutation merely because their wording appears after an API-only clause.
    { index: lastBrowserHandoffIndex(normalized), priority: 3, directive: 'browser-handoff' },
  ];
  const matches = candidates.filter(match => match.index >= 0);
  matches.sort((left, right) => right.index - left.index || right.priority - left.priority);
  return matches[0]?.directive ?? 'none';
}

export function resolveBrowserChannelDirective(
  currentUserRequest: string | undefined,
  objectiveAuthorizationSegments: readonly string[] | undefined,
): BrowserChannelDirective {
  // Authenticated objective segments are the authority boundary. In delegated
  // sessions currentUserRequest can be a model-authored child prompt, so it
  // must never supersede a persisted human root constraint. Only fall back to
  // the raw current request when the host supplied no authenticated segments.
  const candidates = objectiveAuthorizationSegments !== undefined
    ? [...objectiveAuthorizationSegments].reverse()
    : [currentUserRequest];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate && normalizeUserInstructionForChannelMatch(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const directive = classifyBrowserChannelDirective(normalized);
    if (directive !== 'none') return directive;
  }
  return 'none';
}
