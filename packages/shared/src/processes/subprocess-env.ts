/**
 * Environment boundary for long-lived subprocesses.
 *
 * Host processes often contain credentials that are unrelated to the child
 * being launched (CI tokens, cloud credentials, SSH agents, API keys, etc.).
 * Passing `process.env` wholesale turns every child into an implicit secret
 * recipient. This module instead inherits only the small set of variables
 * needed to locate executables, resolve the user's runtime directories, keep
 * locale/terminal behaviour stable, and reach an explicitly configured proxy.
 *
 * Callers may layer `explicitEnv` on top. That map is an intentional grant for
 * one subprocess (for example an MCP source's `config.env`, or Bedrock
 * credentials selected for one Pi runtime), so arbitrary names are preserved.
 */

const SAFE_HOST_ENV_KEYS = new Set([
  // Executable and Windows runtime discovery.
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',

  // User-owned config/cache locations required by CLIs (including Vibe and
  // AWS shared config/SSO files). These are paths, not credential values.
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

  // Temporary files and stable text/terminal behaviour.
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

  // Network proxy and enterprise CA configuration. Proxy URLs can contain
  // credentials, but forwarding them is required for the child to reach the
  // network and is therefore an explicit part of this boundary.
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
  if (SAFE_HOST_ENV_KEYS.has(key)) return true;

  // Environment names are case-insensitive on Windows. Preserve the key's
  // original spelling so Node does not create duplicate PATH/Path entries.
  if (platform === 'win32') {
    const upper = key.toUpperCase();
    return SAFE_HOST_ENV_KEYS.has(upper);
  }

  return false;
}

function copyDefinedValues(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') target[key] = value;
  }
}

/**
 * Pick the non-secret host environment required for a normal CLI child.
 *
 * API keys, CI credentials, cloud credentials, `SSH_AUTH_SOCK`, dynamic-loader
 * injection (`LD_*`/`DYLD_*`) and runtime preloads (`NODE_OPTIONS`) are absent
 * by construction rather than relying on an ever-growing denylist.
 */
export function pickSafeHostEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string' || !isSafeHostKey(key, platform)) continue;
    // Match the MCP SDK's defence against exported shell functions.
    if (value.startsWith('()')) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Build a child environment from a safe host baseline plus one explicit grant.
 * Explicit values win over inherited values and may intentionally contain a
 * credential required by that one child.
 */
export function buildRestrictedSubprocessEnvironment(
  explicitEnv?: Record<string, string | undefined>,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = pickSafeHostEnvironment(baseEnv, platform);
  copyDefinedValues(env, explicitEnv);
  return env;
}
