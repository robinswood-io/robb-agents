import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Antigravity owns its Google account credential in the operating-system
 * keyring. The bridge forwards only ordinary CLI runtime settings and never
 * inherits API keys, OAuth tokens, service-account credentials, or unrelated
 * provider secrets from the Robb process.
 */
const ANTIGRAVITY_SAFE_HOST_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
]);

function isSafeHostKey(key: string, platform: NodeJS.Platform): boolean {
  if (ANTIGRAVITY_SAFE_HOST_ENV_KEYS.has(key)) return true;
  return platform === 'win32' && ANTIGRAVITY_SAFE_HOST_ENV_KEYS.has(key.toUpperCase());
}

export function buildAntigravitySubprocessEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string' || !isSafeHostKey(key, platform)) continue;
    if (value.startsWith('()')) continue;
    env[key] = value;
  }
  return env;
}

export function resolveAntigravityCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const override = environment.ROBB_ANTIGRAVITY_COMMAND?.trim();
  if (override) return override;

  const userHome = environment.HOME || environment.USERPROFILE || homedir();
  const executable = platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = platform === 'win32'
    ? [
        join(userHome, 'AppData', 'Local', 'agy', 'bin', executable),
        join(userHome, '.local', 'bin', executable),
      ]
    : [join(userHome, '.local', 'bin', executable)];
  return candidates.find(pathExists) ?? executable;
}

export interface SpawnAntigravitySubprocessOptions {
  args?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function spawnAntigravitySubprocess(
  command: string,
  cwd: string,
  options: SpawnAntigravitySubprocessOptions = {},
): ChildProcess {
  return spawn(command, options.args ?? [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildAntigravitySubprocessEnvironment(
      options.baseEnv,
      options.platform ?? process.platform,
    ),
  });
}
