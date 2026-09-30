import { z } from 'zod';

/** One contract for provider tool definitions, backend interception and host dispatch. */
export const SpawnSessionSchema = z.object({
  _hostTerminalReconciliationCapability: z.string().min(32).max(128).optional()
    .describe('Host-reserved invocation capability. Never provide this field yourself.'),
  help: z.boolean().optional().describe('If true, returns available sources and role guidance instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional()
    .describe('Canonical permission mode: safe, ask, or allow-all. Omit to inherit. Display labels and aliases such as read-only or execute are invalid.'),
  labels: z.array(z.string()).optional().describe('Labels for the new session. Specify role explicitly; only the exact legacy label reviewer restricts an omitted role to reviewer.'),
  workingDirectory: z.string().optional().describe('Working directory for the new session'),
  projectId: z.string().optional().describe('Workspace project ID. Inherits the project working directory unless overridden.'),
  role: z.enum(['worker', 'reviewer']).optional()
    .describe('worker executes a bounded subtask; reviewer independently inspects the exact target/version and evidence in read-only mode and cannot delegate.'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  }).strict()).optional().describe('Files to include with the prompt'),
}).strict();

export type SpawnSessionInput = z.infer<typeof SpawnSessionSchema>;

export const SPAWN_SESSION_ROLE_HELP = Object.freeze({
  defaultRole: 'worker',
  roles: {
    worker: 'Executes a bounded subtask within inherited permissions and delegation limits.',
    reviewer: 'Independently inspects the exact parent target/version and evidence. Always safe/read-only; cannot delegate.',
  },
  reviewerExample: { role: 'reviewer', permissionMode: 'safe', prompt: 'Inspect the supplied final target and return evidence-bound findings.' },
  legacyLabel: 'Only an exact reviewer label with role omitted selects reviewer for compatibility. Explicit role always wins; other labels and prompt wording do not select a role.',
});

/** Structured diagnostic contains field names, never prompt, path or credential values. */
export class SpawnSessionInputError extends Error {
  readonly code = 'invalid_spawn_session_arguments';
  readonly retryable = false;
  constructor(readonly fields: string[]) {
    super(`Invalid spawn_session arguments (${fields.join(', ')}). Use the exact tool schema; permissionMode must be safe, ask, or allow-all, or omitted to inherit. Correct the arguments before retrying; no session was created.`);
    this.name = 'SpawnSessionInputError';
  }
  toJSON() { return { code: this.code, retryable: this.retryable, fields: this.fields, message: this.message }; }
}

export function parseSpawnSessionInput(input: unknown): SpawnSessionInput {
  let contractInput = input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const { _intent, _displayName, ...rest } = input as Record<string, unknown>;
    contractInput = rest;
  }
  const parsed = SpawnSessionSchema.safeParse(contractInput);
  if (!parsed.success) {
    const knownFields = new Set(Object.keys(SpawnSessionSchema.shape));
    const fields = [...new Set(parsed.error.issues.map(issue => (
      typeof issue.path[0] === 'string' && knownFields.has(issue.path[0]) ? issue.path[0] : 'arguments'
    )))];
    throw new SpawnSessionInputError(fields);
  }
  if (!parsed.data.help && !parsed.data.prompt?.trim()) throw new SpawnSessionInputError(['prompt']);
  // Historical callers selected reviews with a label. This compatibility
  // path only reduces authority; an explicit role is never overwritten.
  if (parsed.data.role === undefined && parsed.data.labels?.includes('reviewer')) {
    return { ...parsed.data, role: 'reviewer' };
  }
  return parsed.data;
}
