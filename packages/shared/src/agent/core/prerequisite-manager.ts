/**
 * PrerequisiteManager - Prerequisite Reading System
 *
 * Blocks tool calls until specified files have been read in the current context window.
 * State resets on compaction since the LLM loses the guide content.
 *
 * Key responsibilities:
 * - Track which files have been read via the Read tool
 * - Check prerequisites before tool execution (e.g., guide.md for sources)
 * - Reset state on context compaction
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expandPath } from './path-processor.ts';
import { getBrowserToolEnabled } from '../../config/storage.ts';

// ============================================================
// Types
// ============================================================

export interface PrerequisiteRule {
  /** Match tool names that require prerequisites */
  toolMatcher: (toolName: string) => boolean;
  /** Resolve the required file path for a matched tool. Returns null to skip. */
  resolveRequiredPath: (toolName: string, workspaceRootPath: string) => string | null;
  /** Block message template. {filePath} is replaced with the required path. */
  blockMessage: string;
  /** Retained for compatibility; every prerequisite now requires a successful read. */
  strict?: boolean;
}

export interface PrerequisiteCheckResult {
  allowed: boolean;
  blockReason?: string;
}

export interface PrerequisiteManagerConfig {
  workspaceRootPath: string;
  onDebug?: (message: string) => void;
  /** The stable system prompt already contains the complete browser contract. */
  browserGuideLoadedInContext?: boolean;
}

// ============================================================
// Constants
// ============================================================

/** Slugs that are exempt from prerequisite checks (internal sources) */
const EXEMPT_SLUGS = new Set(['session', 'craft-agents-docs']);

/** A deliberately small acquisition grammar: no pipelines, substitution or redirection. */
function fullCatPaths(command: unknown): string[] {
  if (typeof command !== 'string' || command.length > 16_384 || /[\r\n]/.test(command)) return [];
  const tokens: string[] = [];
  const token = /\s*(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()]+))/y;
  let offset = 0;
  while (offset < command.length) {
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match) return command.slice(offset).trim() ? [] : paths();
    tokens.push(match[1] ?? match[2] ?? match[3]!);
    offset = token.lastIndex;
    if (offset < command.length && !/\s/.test(command[offset]!)) return [];
  }
  return paths();
  function paths(): string[] {
    if (tokens[0] !== 'cat' && tokens[0] !== '/bin/cat') return [];
    const files = tokens.slice(tokens[1] === '--' ? 2 : 1);
    return files.length && files.every(file => file.length > 0 && !file.startsWith('-')) ? files : [];
  }
}

/** Global browser tools docs path required before browser tool usage. */
function getBrowserToolsDocPath(): string {
  const configDir = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
  return resolve(join(configDir, 'docs', 'browser-tools.md'));
}

// ============================================================
// Rules
// ============================================================

/**
 * Static prerequisite rules. Each rule defines:
 * - Which tools it applies to
 * - What file must be read first
 * - What message to show when blocking
 */
const RULES: PrerequisiteRule[] = [
  // MCP source tools: mcp__{slug}__* format
  {
    toolMatcher: (toolName: string) => {
      if (!toolName.startsWith('mcp__')) return false;
      const parts = toolName.split('__');
      if (parts.length < 3) return false;
      const slug = parts[1]!;
      return !EXEMPT_SLUGS.has(slug);
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const parts = toolName.split('__');
      const slug = parts[1]!;
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Use Read on {filePath} without offset or limit, then retry after it succeeds.',
  },

  // API source tools: api_{slug} format
  {
    toolMatcher: (toolName: string) => {
      return toolName.startsWith('api_');
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const slug = toolName.slice(4); // Remove 'api_' prefix
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Use Read on {filePath} without offset or limit, then retry after it succeeds.',
  },

  // Built-in browser tool: require browser-tools.md first.
  // Only matches the session-scoped tool (not external MCP browser tools like mcp__playwright__*),
  // and skipped entirely when the built-in browser tool is disabled.
  {
    toolMatcher: (toolName: string) =>
      getBrowserToolEnabled() &&
      (toolName === 'browser_tool' || toolName === 'mcp__session__browser_tool'),
    resolveRequiredPath: () => {
      const browserToolsDocPath = getBrowserToolsDocPath();
      return existsSync(browserToolsDocPath) ? browserToolsDocPath : null;
    },
    blockMessage:
      'You must read the browser tools guide before using browser automation. Use Read on {filePath} without offset or limit, then retry after it succeeds.',
    strict: true,
  },
];

// ============================================================
// PrerequisiteManager
// ============================================================

export class PrerequisiteManager {
  private readFiles: Set<string> = new Set();
  private persistentContextFiles: Set<string> = new Set();
  private pendingSkillPaths: Set<string> = new Set();
  private registeredSkillPaths: Set<string> = new Set();
  private readAttempts = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  private workspaceRootPath: string;
  private onDebug?: (message: string) => void;

  constructor(config: PrerequisiteManagerConfig) {
    this.workspaceRootPath = config.workspaceRootPath;
    this.onDebug = config.onDebug;

    if (config.browserGuideLoadedInContext) {
      const browserToolsDocPath = getBrowserToolsDocPath();
      if (existsSync(browserToolsDocPath)) {
        this.persistentContextFiles.add(browserToolsDocPath);
        this.readFiles.add(browserToolsDocPath);
        this.onDebug?.(`Prerequisite: browser guide already loaded in stable system context ${browserToolsDocPath}`);
      }
    }
  }

  /**
   * Register skill SKILL.md paths as prerequisites.
   * All tool calls (except Read targeting these paths) are blocked
   * until the files have been read.
   */
  registerSkillPrerequisites(paths: string[]): void {
    for (const path of paths) {
      const expanded = expandPath(path);
      this.registeredSkillPaths.add(expanded);
      if (!this.readFiles.has(expanded)) this.pendingSkillPaths.add(expanded);
      this.onDebug?.(`Prerequisite: registered skill prerequisite ${expanded}`);
    }
  }

  /**
   * Mark source guides whose complete contents have already been injected into
   * the model's current context.
   *
   * This is the host-side counterpart to preloading guides before a turn. It is
   * deliberately limited to `sources/{slug}/guide.md`: callers cannot use this
   * API to bypass strict browser or dynamic skill prerequisites. The state is
   * cleared by {@link resetReadState}, so a compaction requires reinjection.
   */
  markSourceGuidesLoadedInContext(filePaths: readonly string[]): void {
    const sourcesRoot = resolve(this.workspaceRootPath, 'sources');

    for (const filePath of filePaths) {
      const expanded = expandPath(filePath, this.workspaceRootPath);
      const relativePath = relative(sourcesRoot, expanded);
      const segments = relativePath.split(/[\\/]/).filter(Boolean);
      const isSourceGuide = relativePath.length > 0
        && !relativePath.startsWith('..')
        && !isAbsolute(relativePath)
        && segments.length === 2
        && segments[1] === 'guide.md';

      if (!isSourceGuide || !existsSync(expanded)) {
        this.onDebug?.(`Prerequisite: ignored invalid preloaded source guide ${expanded}`);
        continue;
      }

      this.readFiles.add(expanded);
      this.onDebug?.(`Prerequisite: source guide already loaded in context ${expanded}`);
    }
  }

  /**
   * Check if a tool call's prerequisites are met.
   * Iterates rules, checks if required files have been read.
   * Retrying a blocked tool never satisfies its prerequisite.
   */
  checkPrerequisites(toolName: string): PrerequisiteCheckResult {
    // Check dynamic skill prerequisites first
    const skillResult = this.checkSkillPrerequisites(toolName);
    if (!skillResult.allowed) return skillResult;

    for (const rule of RULES) {
      if (!rule.toolMatcher(toolName)) continue;

      const requiredPath = rule.resolveRequiredPath(toolName, this.workspaceRootPath);
      if (!requiredPath) continue; // No guide.md exists, skip

      if (!this.readFiles.has(requiredPath)) {
        const blockReason = rule.blockMessage.replace('{filePath}', requiredPath);
        this.onDebug?.(`Prerequisite blocked: ${toolName} requires ${requiredPath}`);
        return { allowed: false, blockReason };
      }
    }

    return { allowed: true };
  }

  /**
   * Check dynamic skill prerequisites.
   * If pending skill paths exist and the tool is NOT a Read targeting one of them, block.
   */
  private checkSkillPrerequisites(toolName: string): PrerequisiteCheckResult {
    if (this.pendingSkillPaths.size === 0) return { allowed: true };

    // Allow Read tool through — trackReadTool will clear the prerequisite
    if (toolName === 'Read') return { allowed: true };

    const pendingList = [...this.pendingSkillPaths].join(', ');
    const blockReason = `You must read the skill instruction files before proceeding. Use Read without offset or limit, or a single \`cat -- <paths>\` command to read: ${pendingList}. Repeating another tool does not clear this prerequisite.`;
    this.onDebug?.(`Skill prerequisite blocked: ${toolName} — pending: ${pendingList}`);
    return { allowed: false, blockReason };
  }

  /**
   * Credit a completed full-file read, never a tool start or attempted invocation.
   * Extracts file_path from tool input,
   * normalizes it, and adds to the read set.
   * Also clears matching pending skill paths.
   */
  trackReadTool(toolInput: Record<string, unknown>): void {
    if (toolInput.offset !== undefined || toolInput.limit !== undefined) return;
    const filePath = (toolInput.file_path as string) || (toolInput.path as string);
    if (!filePath) return;

    const expanded = expandPath(filePath);
    this.readFiles.add(expanded);

    // Clear matching pending skill path
    if (this.pendingSkillPaths.has(expanded)) {
      this.pendingSkillPaths.delete(expanded);
      this.onDebug?.(`Prerequisite: cleared skill prerequisite ${expanded}`);
    }

    this.onDebug?.(`Prerequisite: tracked read of ${expanded}`);
  }

  /**
   * Permit an exact full-file acquisition command without crediting it yet.
   * Called from the pre-tool-use pipeline to allow targeted Bash reads through.
   */
  trackBashSkillRead(input: Record<string, unknown>): boolean {
    const paths = fullCatPaths(input.command);
    return paths.length > 0 && paths.every(path => this.pendingSkillPaths.has(expandPath(path)));
  }

  trackToolStart(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    if (toolName !== 'Read' && toolName !== 'Bash') return;
    if (this.readAttempts.size >= 128) this.readAttempts.delete(this.readAttempts.keys().next().value!);
    this.readAttempts.set(toolUseId, { toolName, input: { ...input } });
  }

  trackToolCompletion(toolUseId: string, result: unknown, isError: boolean, executed = true): void {
    const attempt = this.readAttempts.get(toolUseId);
    this.readAttempts.delete(toolUseId);
    if (attempt) this.trackToolResult(attempt.toolName, attempt.input, result, isError, executed);
  }

  /** Called only with backend-observed results, before later tools are released. */
  trackToolResult(toolName: string, input: Record<string, unknown>, result: unknown, isError: boolean, executed = true): void {
    if (isError || !executed || result == null || result === ''
      || (typeof result === 'object' && (result as { isError?: unknown }).isError === true)) return;
    if (toolName === 'Read') this.trackReadTool(input);
    if (toolName === 'Bash') {
      for (const path of fullCatPaths(input.command)) this.trackReadTool({ file_path: path });
    }
  }

  /**
   * Reset read state. Called on context compaction since the LLM
   * loses the guide content and needs to re-read.
   * Registered skills must be read again because their contents were compacted.
   */
  resetReadState(): void {
    const count = this.readFiles.size;
    const skillCount = this.pendingSkillPaths.size;
    this.readFiles.clear();
    for (const filePath of this.persistentContextFiles) {
      this.readFiles.add(filePath);
    }
    this.pendingSkillPaths = new Set(this.registeredSkillPaths);
    this.readAttempts.clear();
    this.onDebug?.(`Prerequisite: reset read state (cleared ${count} reads, ${skillCount} skill prerequisites)`);
  }

  /**
   * Check if a specific file has been read (for testing).
   */
  hasRead(filePath: string): boolean {
    return this.readFiles.has(expandPath(filePath));
  }
}
