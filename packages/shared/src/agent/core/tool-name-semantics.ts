/**
 * Conservative, provider-independent semantics for externally supplied tool
 * names. Tool names are hints, never proof that an operation is read-only.
 */

export type ToolNameMutationSemantics = 'mutation' | 'ambiguous-compound' | 'neutral';

const COMMON_MUTATION_TOKENS = new Set([
  'accept',
  'activate',
  'add',
  'alter',
  'append',
  'apply',
  'approve',
  'archive',
  'assign',
  'attach',
  'cancel',
  'close',
  'commit',
  'copy',
  'create',
  'deactivate',
  'decrement',
  'delete',
  'deploy',
  'disable',
  'disconnect',
  'drop',
  'edit',
  'enable',
  'execute',
  'grant',
  'import',
  'increment',
  'insert',
  'install',
  'invite',
  'link',
  'lock',
  'mark',
  'merge',
  'move',
  'mutate',
  'mutation',
  'patch',
  'pay',
  'pin',
  'post',
  'publish',
  'purchase',
  'remove',
  'rename',
  'replace',
  'reply',
  'register',
  'reset',
  'restart',
  'restore',
  'revoke',
  'rotate',
  'run',
  'schedule',
  'save',
  'send',
  'set',
  'share',
  'sign',
  'start',
  'stop',
  'submit',
  'sync',
  'transfer',
  'trigger',
  'truncate',
  'uninstall',
  'unpin',
  'unregister',
  'unlink',
  'unlock',
  'update',
  'upload',
  'upsert',
  'write',
]);

export function normalizeToolLeafName(toolName: string): string {
  const leafName = toolName.split('__').at(-1) ?? toolName;
  return leafName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Identify explicit mutations and fail closed on mixed compound names.
 *
 * A compound such as `search_and_transform` cannot inherit read authority
 * merely because a broad permissions regex matches `search`. If no known
 * mutation token is present, it remains unknown so normal permission and
 * high-stakes gates can decide rather than treating it as a typed read.
 */
export function classifyToolNameMutationSemantics(toolName: string): ToolNameMutationSemantics {
  const tokens = normalizeToolLeafName(toolName).split('_').filter(Boolean);
  if (tokens.some(token => COMMON_MUTATION_TOKENS.has(token))) return 'mutation';
  if (tokens.includes('and')) return 'ambiguous-compound';
  return 'neutral';
}
