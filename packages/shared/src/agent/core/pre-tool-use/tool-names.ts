
// ============================================================
// BUILT-IN TOOLS
// ============================================================

/** SDK built-in tools that should NOT have metadata stripped */
export const BUILT_IN_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'SubmitPlan',
  'Skill',
  'SlashCommand',
  'TaskStop',
]);

/** Tools that operate on file paths */
export const FILE_PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
]);

/** Tools that can write config files */
export const CONFIG_WRITE_TOOLS = new Set(['Write', 'Edit']);

/** File tools blocked for labels domain. */
export const LABELS_BLOCKED_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

export function normalizeAutonomyGuardText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Built-in MCP servers that are always available (not user sources) */
export const BUILT_IN_MCP_SERVERS = new Set(['session', 'craft-agents-docs']);

/** File write tools that require permission in ask mode */
export const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const BUILTIN_READ_TOOLS = new Set([
  'Read', 'Find', 'Grep', 'Glob', 'LS', 'Ls', 'TodoRead', 'WebFetch', 'WebSearch',
]);

export const REMOTE_COMMAND_TOOL_PATTERN = /(?:^|__)(?:ssh_(?:execute|exec)(?:_sudo)?|remote_(?:execute|exec)|run_command)$/i;

export const MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|POST|PUT)$/i;

export const STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS = new Set([
  'mcp__rbw-servers__ssh_session_start',
  'mcp__rbw-servers__ssh_download',
]);
