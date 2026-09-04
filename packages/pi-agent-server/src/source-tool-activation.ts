const LARGE_SOURCE_TOOL_THRESHOLD = 80;

const FAMILY_KEYWORDS: Readonly<Record<string, RegExp>> = {
  docs: /\b(?:doc(?:ument)?s?|nda|non[- ]disclosure|confidentialite|contrat|contract|accord|agreement|clause|juridique|legal|lettre|letter|memo|rapport|report|cv|curriculum vitae)\b/i,
  drive: /\b(?:drive|fichiers?|files?|dossiers?|folders?|upload|telecharg(?:er|ement)|download)\b/i,
  gmail: /\b(?:gmail|e-?mails?|mails?|courriels?|inbox|boite de reception|message electronique)\b/i,
  contacts: /\b(?:contacts?|carnet d['’]adresses?|address book|destinataires?|recipients?)\b/i,
  calendar: /\b(?:calendar|calendrier|agenda|rendez[- ]vous|appointments?|evenements?|events?|disponibilites?|availability)\b/i,
  meet: /\b(?:google meet|visioconference|video ?call|conference call|meeting|reunion)\b/i,
  sheets: /\b(?:sheets?|spreadsheet|tableurs?|feuilles? de calcul|excel|xlsx|csv|cellules?)\b/i,
  slides: /\b(?:slides?|diaporamas?|powerpoints?|pptx?|pitch decks?|presentations?)\b/i,
  forms: /\b(?:google forms?|formulaires?|questionnaires?|sondages?|surveys?)\b/i,
  chat: /\b(?:google chat|espaces? de discussion|chat spaces?)\b/i,
  youtube: /\b(?:youtube|videos?|channels?|chaines?|playlists?)\b/i,
  tasks: /\b(?:google tasks?|to[- ]?dos?|listes? de taches|task ?lists?)\b/i,
  notes: /\b(?:google keep|keep notes?|notes?)\b/i,
};

const FAMILY_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  docs: ['drive'],
  gmail: ['contacts'],
  calendar: ['meet', 'contacts'],
  meet: ['calendar', 'contacts'],
  sheets: ['drive'],
  slides: ['drive'],
  forms: ['drive'],
  chat: ['contacts'],
};

const KNOWN_FAMILIES = new Set(Object.keys(FAMILY_KEYWORDS));

type ParsedSourceTool = {
  source: string;
  localName: string;
  family: string;
};

export interface SourceToolActivationDecision {
  activeToolNames: string[];
  filtered: boolean;
  selectedFamilies: string[];
  sourceToolsActive: number;
  sourceToolsTotal: number;
}

function parseSourceToolName(name: string): ParsedSourceTool | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match || match[1] === 'session') return null;
  const source = match[1]!;
  const localName = match[2]!;
  return {
    source,
    localName,
    family: localName.split('_', 1)[0]!,
  };
}

function isDiscoveryTool(localName: string): boolean {
  return localName === 'search_all'
    || localName === 'search_drive'
    || localName === 'search_gmail'
    || localName === 'gmail_search_exact'
    || localName === 'get_index_status'
    || localName === 'sync_now'
    || localName.endsWith('_connection_healthcheck')
    || localName.endsWith('_workspace_healthcheck')
    || localName === 'google_auth'
    || localName === 'google_auth_status'
    || localName === 'google_auth_code';
}

function detectFamilies(text: string): Set<string> {
  const searchableText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const detected = new Set<string>();
  for (const [family, pattern] of Object.entries(FAMILY_KEYWORDS)) {
    if (pattern.test(searchableText)) detected.add(family);
  }
  return detected;
}

function addDependencies(families: Set<string>): void {
  const queue = [...families];
  while (queue.length > 0) {
    const family = queue.shift()!;
    for (const dependency of FAMILY_DEPENDENCIES[family] ?? []) {
      if (!families.has(dependency)) {
        families.add(dependency);
        queue.push(dependency);
      }
    }
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Extract a small amount of prior user intent without retaining tool output. */
export function extractRecentUserTexts(messages: readonly unknown[], limit = 6): string[] {
  const texts: string[] = [];
  for (let index = messages.length - 1; index >= 0 && texts.length < limit; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== 'user') continue;
    const text = contentToText(candidate.content).trim();
    if (text) texts.push(text);
  }
  return texts.reverse();
}

/**
 * Keeps normal sources fully available and narrows only unusually large,
 * multi-product MCP aggregators. Ambiguous fresh prompts fail open to every
 * tool; recognized intent and prior intent keep the relevant families sticky.
 */
export class SourceToolActivationController {
  private readonly stickyFamilies = new Set<string>();

  select(
    allToolNames: readonly string[],
    currentPrompt: string,
    recentUserTexts: readonly string[] = [],
  ): SourceToolActivationDecision {
    const sourceGroups = new Map<string, Array<{ name: string; parsed: ParsedSourceTool }>>();
    const alwaysActive: string[] = [];

    for (const name of allToolNames) {
      const parsed = parseSourceToolName(name);
      if (!parsed) {
        alwaysActive.push(name);
        continue;
      }
      const group = sourceGroups.get(parsed.source) ?? [];
      group.push({ name, parsed });
      sourceGroups.set(parsed.source, group);
    }

    const detected = detectFamilies([...recentUserTexts, currentPrompt].join('\n'));
    for (const family of detected) this.stickyFamilies.add(family);
    addDependencies(this.stickyFamilies);

    const active = [...alwaysActive];
    let sourceToolsActive = 0;
    let sourceToolsTotal = 0;
    let filtered = false;

    for (const group of sourceGroups.values()) {
      sourceToolsTotal += group.length;
      const knownToolCount = group.filter(({ parsed }) => KNOWN_FAMILIES.has(parsed.family)).length;
      const isLargeWorkspaceAggregator = group.length > LARGE_SOURCE_TOOL_THRESHOLD
        && knownToolCount >= LARGE_SOURCE_TOOL_THRESHOLD / 2;

      // Preserve every tool for normal sources and for ambiguous fresh intent.
      if (!isLargeWorkspaceAggregator || this.stickyFamilies.size === 0) {
        active.push(...group.map(({ name }) => name));
        sourceToolsActive += group.length;
        continue;
      }

      const selected = group.filter(({ parsed }) =>
        isDiscoveryTool(parsed.localName) || this.stickyFamilies.has(parsed.family));
      active.push(...selected.map(({ name }) => name));
      sourceToolsActive += selected.length;
      filtered ||= selected.length < group.length;
    }

    return {
      activeToolNames: active,
      filtered,
      selectedFamilies: [...this.stickyFamilies].sort(),
      sourceToolsActive,
      sourceToolsTotal,
    };
  }
}
