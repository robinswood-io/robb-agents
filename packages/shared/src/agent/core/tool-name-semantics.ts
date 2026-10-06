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
  'change',
  'clear',
  'clone',
  'close',
  'commit',
  'configure',
  'copy',
  'create',
  'deactivate',
  'deprovision',
  'decrement',
  'delete',
  'deploy',
  'disable',
  'disconnect',
  'destroy',
  'drop',
  'duplicate',
  'edit',
  'enable',
  'erase',
  'execute',
  'export',
  'forward',
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
  'modify',
  'move',
  'mutate',
  'mutation',
  'patch',
  'pay',
  'pin',
  'post',
  'publish',
  'purchase',
  'purge',
  'provision',
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
  'wipe',
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

/** First explicit mutation verb in a provider-supplied tool/action name. */
export function toolNameMutationToken(toolName: string): string | undefined {
  return normalizeToolLeafName(toolName).split('_').find(token => COMMON_MUTATION_TOKENS.has(token));
}
