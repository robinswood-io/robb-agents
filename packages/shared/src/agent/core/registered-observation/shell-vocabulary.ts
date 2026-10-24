import type { CompiledBashPattern } from "../../mode-types.ts";

const OBJECTIVE_SHELL_EXECUTOR_TOOL_NAME = /(?:^|[_:.])(?:bash|shell|exec_command|ssh_execute)$/i;

/** Native or namespaced tools whose command/cmd/script input executes a shell. */
export function isObjectiveShellExecutorToolName(toolName: string): boolean {
  return toolName.length > 0 && toolName.length <= 512
    && OBJECTIVE_SHELL_EXECUTOR_TOOL_NAME.test(toolName);
}

export const OBJECTIVE_READ_ONLY_SHELL_PATTERNS: CompiledBashPattern[] = [
  {
    regex: /^cd(?:\s|$)/,
    source: 'working-directory selection within the bounded shell process',
  },
  {
    // The AST validator still rejects redirects, substitutions, expansions and
    // background execution. Exclude both spellings of -v and the %n conversion:
    // each assigns a shell variable rather than writing only to stdout.
    regex: /^printf\b(?!\s+-v(?:[A-Za-z_][A-Za-z0-9_]*)?(?:\s|$))(?![^\r\n]*%(?:[0-9]+\$)?[-+ #0']*(?:\*|[0-9]+)?(?:\.(?:\*|[0-9]+))?(?:hh|h|ll|l|j|z|t|L)?n)/,
    source: 'stdout-only printf without variable assignment',
  },
  {
    regex: /^(?:cat|grep|head|ls|pwd|stat|tail|test|wc)(?:\s|$)/,
    source: 'closed objective read-only utilities',
  },
  {
    regex: /^diff\b(?![^\n]*\s--output(?:=|\s|$))/,
    source: 'diff without output-file mutation',
  },
  {
    regex: /^(?:cmp\s+-s\s+[A-Za-z0-9_@%+=:,./-]+(?: [A-Za-z0-9_@%+=:,./-]+)*\s+[A-Za-z0-9_@%+=:,./-]+(?: [A-Za-z0-9_@%+=:,./-]+)*|shasum\s+-a\s+256\s+[A-Za-z0-9_@%+=:,./-]+(?: [A-Za-z0-9_@%+=:,./-]+)*)$/,
    source: 'closed static file integrity checks',
  },
  {
    regex: /^find(?:\s|$)/,
    source: 'find without execution or deletion flags',
  },
  {
    regex: /^rg(?![^\n]*(?:--pre(?:-glob)?)(?:=|\s))(?:\s|$)/,
    source: 'ripgrep without command preprocessors',
  },
  {
    // Options are validated per subcommand by
    // objectiveGitReadsUseAllowlistedOptions below. The pattern only selects
    // the closed read-only operation set.
    regex: /^git\s+--no-optional-locks\s+-c\s+core\.fsmonitor=false\s+-c\s+core\.hooksPath=\/dev\/null\s+-c\s+log\.showSignature=false\s+-c\s+format\.pretty=medium\s+--no-pager\s+(?:-C\s+[^\s]+\s+)?(?:branch\s+--show-current|grep|log|ls-files|merge-base|rev-parse)(?:\s|$)/,
    source: 'closed read-only git operations',
  },
  {
    // Only numeric line-range printing over literal paths. sed's in-place,
    // file-write and shell-execution forms deliberately cannot match.
    regex: /^sed\s+(?:-n|--quiet|--silent)\s+[1-9]\d*(?:,[1-9]\d*)?p(?:\s+(?!-)(?![^\s]*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_@%+=:,./()\-]+)*$/,
    source: 'closed sed numeric line-range inspection',
  },
];

// Keep this list aligned with the test/check commands that the objective
// outcome gate already treats as observations. Unlike Explore permissions,
// this is only evidence classification after an exact completed invocation.
export const OBJECTIVE_TEST_SHELL_PATTERNS: CompiledBashPattern[] = [
  {
    regex: /^(?:bun|npm|pnpm|yarn)\s+(?:test(?:\s|$)|run\s+(?:check|lint|test|typecheck)(?=$|[\s:_-]))/,
    source: 'closed objective test commands',
  },
  {
    regex: /^(?:pytest|go\s+test|cargo\s+test)(?:\s|$)/,
    source: 'closed objective test runners',
  },
  {
    regex: /^tsc\b(?=[^\n]*--noEmit(?:\s|$))/,
    source: 'TypeScript no-emit validation',
  },
];

export function isTrustedCurlExecutable(name: string): boolean {
  return name === 'curl' || name === '/usr/bin/curl';
}

export function literalCommand(value: unknown, allowDevNull: boolean): { name: string; args: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (node.type !== 'Command' || node.async || (Array.isArray(node.prefix) && node.prefix.length > 0)) return undefined;
  const literal = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const word = value as { type?: string; text?: string; expansion?: unknown[] };
    return word.type === 'Word' && typeof word.text === 'string' && !word.expansion?.length
      ? word.text : undefined;
  };
  const name = literal(node.name);
  if (!name) return undefined;
  const args: string[] = [];
  for (const suffix of Array.isArray(node.suffix) ? node.suffix : []) {
    const arg = literal(suffix);
    if (arg !== undefined) { args.push(arg); continue; }
    const redirect = suffix as { type?: string; file?: unknown; op?: { text?: string } };
    // Discarding output does not create evidence; the caller still requires
    // the exact observed result. Real file redirects remain excluded.
    if (!allowDevNull || redirect.type !== 'Redirect' || literal(redirect.file) !== '/dev/null'
      || !/^(?:>|>>|>\|)$/.test(redirect.op?.text ?? '')) return undefined;
  }
  return { name, args };
}
