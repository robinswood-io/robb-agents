import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Vibe owns its local subscription credential, but it still needs normal CLI
 * runtime paths, locale, proxy and certificate settings. Keep this allowlist
 * local to the standalone bridge bundle so the package has no runtime
 * dependency on @craft-agent/shared.
 */
const VIBE_SAFE_HOST_ENV_KEYS = new Set([
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
  'LC_PAPER',
  'LC_NAME',
  'LC_ADDRESS',
  'LC_TELEPHONE',
  'LC_MEASUREMENT',
  'LC_IDENTIFICATION',
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

function isVibeSafeHostKey(key: string, platform: NodeJS.Platform): boolean {
  if (VIBE_SAFE_HOST_ENV_KEYS.has(key)) return true;
  if (platform === 'win32') {
    const upper = key.toUpperCase();
    return VIBE_SAFE_HOST_ENV_KEYS.has(upper);
  }
  return false;
}

export function buildVibeSubprocessEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string' || !isVibeSafeHostKey(key, platform)) continue;
    if (value.startsWith('()')) continue;
    env[key] = value;
  }
  return env;
}

export interface SpawnVibeSubprocessOptions {
  /** Test seam; production Vibe launches without arguments. */
  args?: string[];
  /** Test seam for proving that ambient secrets are not forwarded. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Launch Vibe with the restricted environment used in production. */
export function spawnVibeSubprocess(
  command: string,
  cwd: string,
  options: SpawnVibeSubprocessOptions = {},
): ChildProcess {
  return spawn(command, options.args ?? [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildVibeSubprocessEnvironment(options.baseEnv),
  });
}
