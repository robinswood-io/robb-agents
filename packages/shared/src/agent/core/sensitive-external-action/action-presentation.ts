import { uniqueTargets } from './action-targets.ts';
import { ACTION_DETAILS } from './host-authorization.ts';
import type { SensitiveConditionalTarget, SensitiveExternalAction, SensitiveExternalActionCategory } from './types.ts';

export function findSshHostIndex(words: string[]): number {
  const optionsWithValues = new Set([
    '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o',
    '-p', '-Q', '-R', '-S', '-W', '-w',
  ]);
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return index;
  }
  return -1;
}

export function positionalAfter(words: string[], actionIndex: number): string[] {
  const positionals: string[] = [];
  const optionsWithValues = new Set([
    '--app', '--context', '--env', '--environment', '--namespace', '--project', '--repo',
    '--secret-id', '--service', '--target', '--vault-name', '-a', '-e', '-n', '-p', '-t',
  ]);
  for (let index = actionIndex + 1; index < words.length; index++) {
    const word = words[index]!;
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    positionals.push(word);
  }
  return positionals;
}

/** Scan headers once; malformed repeated headers cannot trigger backtracking. */
function redactAuthenticationHeaders(command: string): string {
  const pattern = /([a-z0-9-]{1,256})[ \t]{0,256}:[ \t]{0,256}/giu;
  let cursor = 0;
  let output = '';
  for (const match of command.matchAll(pattern)) {
    const start = match.index;
    if (start < cursor) continue;
    const name = match[1]!.toLowerCase().replace(/-/g, '_');
    if (!['authorization', 'proxy_authorization', 'cookie', 'set_cookie'].includes(name)
      && !['api_key', 'apikey', 'access_token', 'refresh_token', 'auth_token', 'csrf_token', 'xsrf_token', 'client_secret', 'password', 'credential', 'session_key']
        .some(token => name.includes(token))) continue;
    let end = start + match[0].length;
    while (end < command.length && !['"', "'", '\r', '\n'].includes(command[end]!)) end++;
    output += command.slice(cursor, start) + match[0] + '[REDACTED]';
    cursor = end;
  }
  return output + command.slice(cursor);
}

export function redactCommandPreview(command: string, category: SensitiveExternalActionCategory): string {
  if (category === 'secret_transfer') return '[Sensitive credential operation — values redacted]';
  return redactAuthenticationHeaders(command)
    // Preserve the header name so the prompt remains useful, but never expose
    // cookies or key-like authentication header values. Handle quoted headers
    // before bare values so a cookie containing spaces/semicolons is redacted
    // as one unit rather than leaking its suffix.
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|csrf[_-]?token|xsrf[_-]?token|client[_-]?secret|token|secret|password|credential|session[_-]?key|cookie)\s*[=:]\s*)(["'])[^'"\r\n]*\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*["']?)[^\s,"'};]+/gi, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|secret|password)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
}

export function safeHttpHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

export function makeAction(
  category: SensitiveExternalActionCategory,
  promptType: SensitiveExternalAction['promptType'],
  commandPreview: string,
  targetCandidates: string[],
  authorizationTermGroups?: string[][],
  conditionalTargetCandidates?: SensitiveConditionalTarget[],
): SensitiveExternalAction {
  const details = ACTION_DETAILS[category];
  const targets = uniqueTargets(targetCandidates);
  const targetLabel = targets[0] ? ` Target: ${targets[0]}.` : '';
  return {
    category,
    promptType,
    description: `Explicit confirmation required: ${details.description}.${targetLabel}`,
    commandPreview,
    reason: details.reason,
    impact: details.impact,
    targetCandidates: targets,
    ...(conditionalTargetCandidates && conditionalTargetCandidates.length > 0
      ? { conditionalTargetCandidates: uniqueConditionalTargets(conditionalTargetCandidates) }
      : {}),
    ...(authorizationTermGroups ? { authorizationTermGroups } : {}),
  };
}

export function uniqueConditionalTargets(
  values: readonly SensitiveConditionalTarget[],
): SensitiveConditionalTarget[] {
  const seen = new Set<string>();
  const result: SensitiveConditionalTarget[] = [];
  for (const candidate of values) {
    const value = candidate.value.trim();
    if (!value || value.length > 200) continue;
    const key = `${candidate.kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: candidate.kind, value });
  }
  return result;
}
