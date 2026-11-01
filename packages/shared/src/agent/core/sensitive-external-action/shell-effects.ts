import { positionalAfter, safeHttpHost } from './action-presentation.ts';
import { uniqueTargets } from './action-targets.ts';
import { normalizedToolAction } from './connector-classification.ts';
import { UNRESOLVED_EXTERNAL_TARGET } from './host-authorization.ts';
import { firstCliActionIndex, optionValue } from './shell-parser.ts';
import { basename } from './target-syntax.ts';
import type { SensitiveExternalActionCategory } from './types.ts';

export function getGitPush(words: string[]): { actionIndex: number; targets: string[] } | null {
  if (basename(words[0] ?? '') !== 'git') return null;
  let index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word)) {
      index += 2;
      continue;
    }
    if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=') || word === '--no-pager') {
      index += 1;
      continue;
    }
    break;
  }
  if (words[index]?.toLowerCase() !== 'push') return null;
  const args = words.slice(index + 1);
  if (args.some(arg => arg === '--dry-run' || arg === '-n')) return null;
  const positionals = args.filter(arg => !arg.startsWith('-'));
  const remote = positionals[0];
  const rawRef = positionals[1];
  const destinationRef = rawRef?.includes(':') ? rawRef.split(':').pop() : rawRef;
  const normalizedRef = destinationRef?.replace(/^refs\/heads\//, '');
  return {
    actionIndex: index,
    targets: uniqueTargets([
      remote && normalizedRef ? `${remote} ${normalizedRef}` : remote,
    ]),
  };
}

export function classifyDeployment(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  if (lowerWords.some(word => ['--dry-run', '--preview'].includes(word))) return null;
  const dockerActionIndex = command === 'docker'
    ? firstCliActionIndex(words, 1, new Set(['--config', '--context', '--host', '-H', '--log-level']))
    : -1;
  const kubectlActionIndex = command === 'kubectl'
    ? firstCliActionIndex(words, 1, new Set(['--context', '--namespace', '-n', '--server', '--user']))
    : -1;

  let actionIndex = -1;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && /^deploy(?::[a-z0-9_-]+)?$/.test(word));
  } else if (/^deploy(?:[-_.][a-z0-9_-]+)?(?:\.sh)?$/.test(command)) {
    actionIndex = 0;
  } else if (['vercel', 'firebase', 'fly', 'flyctl', 'wrangler', 'render'].includes(command)) {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && word === 'deploy');
    if (command === 'vercel' && actionIndex < 0 && lowerWords.includes('--prod')) actionIndex = 0;
  } else if (command === 'railway' && lowerWords[1] === 'up') {
    actionIndex = 1;
  } else if (command === 'gcloud') {
    actionIndex = lowerWords.findIndex((word, index) => index > 0 && word === 'deploy');
  } else if (command === 'kubectl' && ['apply', 'replace'].includes(lowerWords[kubectlActionIndex] ?? '')) {
    actionIndex = kubectlActionIndex;
  } else if (command === 'helm' && ['install', 'upgrade'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
  } else if (command === 'terraform' && lowerWords[1] === 'apply') {
    actionIndex = 1;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'stack'
    && lowerWords[dockerActionIndex + 1] === 'deploy') {
    actionIndex = dockerActionIndex + 1;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'compose') {
    // `compose up` may create or recreate a shared service. Options such as
    // `--profile` can appear before the action (as in the audited prod command).
    actionIndex = lowerWords.findIndex((word, index) => index > dockerActionIndex && word === 'up');
  } else if (command === 'gh' && lowerWords[1] === 'workflow' && lowerWords[2] === 'run') {
    actionIndex = 2;
  }
  if (actionIndex < 0) return null;

  const namedTargets = [
    optionValue(words, ['--app', '-a']),
    optionValue(words, ['--environment', '--env', '-e']),
    optionValue(words, ['--project', '-p']),
    optionValue(words, ['--service']),
    optionValue(words, ['--target', '-t']),
    optionValue(words, ['--namespace', '-n']),
    optionValue(words, ['--context']),
    optionValue(words, ['--profile']),
  ];
  return {
    actionIndex,
    targets: uniqueTargets([...namedTargets, ...positionalAfter(words, actionIndex)]),
  };
}

function isRemotePythonSecretWrite(command: string): boolean {
  return /\bpython(?:[0-9.]+)?\b/i.test(command)
    && /\.write_(?:text|bytes)\s*\(/i.test(command)
    && /(?:^|[/"'])\.env(?:\.[A-Za-z0-9_-]+)?\b/i.test(command)
    && /(?:NIGHT_AGENT_API_KEY|api[_-]?key|secret|credential|token|password|private[_-]?key)/i.test(command);
}

function isRemoteShellSecretWrite(command: string): boolean {
  const sensitiveValue = /(?:NIGHT_AGENT_API_KEY|api[_-]?key|secret|credential|token|password|private[_-]?key)/i;
  const secretDestination = /(?:>{1,2}\s*|\btee(?:\s+-a)?\s+)["']?[^\s"']*(?:\.env(?:\.[A-Za-z0-9_-]+)?|secrets?|credentials?|api[_-]?keys?|private[_-]?keys?)(?:\b|[/_.-])/i;
  return sensitiveValue.test(command) && secretDestination.test(command);
}

export function isRemoteInlineSecretWrite(command: string): boolean {
  return isRemotePythonSecretWrite(command) || isRemoteShellSecretWrite(command);
}

export function classifyRestart(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  let actionIndex = -1;

  const systemctlActionIndex = command === 'systemctl'
    ? firstCliActionIndex(words, 1, new Set(['-H', '--host', '-M', '--machine', '--root', '--image']))
    : -1;
  const dockerActionIndex = command === 'docker'
    ? firstCliActionIndex(words, 1, new Set(['--config', '--context', '--host', '-H', '--log-level']))
    : -1;
  const kubectlActionIndex = command === 'kubectl'
    ? firstCliActionIndex(words, 1, new Set(['--context', '--namespace', '-n', '--server', '--user']))
    : -1;

  if (command === 'systemctl' && ['start', 'restart', 'try-restart'].includes(lowerWords[systemctlActionIndex] ?? '')) {
    actionIndex = systemctlActionIndex;
  } else if (command === 'service' && ['start', 'restart'].includes(lowerWords[2] ?? '')) {
    actionIndex = 2;
  } else if (command === 'docker' && ['start', 'restart'].includes(lowerWords[dockerActionIndex] ?? '')) {
    actionIndex = dockerActionIndex;
  } else if (command === 'docker' && lowerWords[dockerActionIndex] === 'compose') {
    actionIndex = lowerWords.findIndex((word, index) => index > dockerActionIndex && word === 'restart');
  } else if (['pm2', 'supervisorctl'].includes(command) && ['restart', 'reload'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
  } else if (command === 'kubectl' && lowerWords[kubectlActionIndex] === 'rollout'
    && lowerWords[kubectlActionIndex + 1] === 'restart') {
    actionIndex = kubectlActionIndex + 1;
  } else if (command === 'brew' && lowerWords[1] === 'services' && lowerWords[2] === 'restart') {
    actionIndex = 2;
  } else if (command === 'launchctl' && lowerWords[1] === 'kickstart') {
    actionIndex = 1;
  }
  if (actionIndex < 0) return null;
  return {
    actionIndex,
    targets: uniqueTargets(positionalAfter(words, actionIndex)),
  };
}

export function classifySecretWrite(words: string[], rawCommand: string): string[] | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  const rawLower = rawCommand.toLowerCase();
  const sensitiveMarker = /(?:^|[/_.-])(?:\.env|secret|credential|api[_-]?key|private[_-]?key|id_rsa|id_ed25519)(?=$|[\s/_.-])/i;

  if (['scp', 'rsync', 'sftp'].includes(command)) {
    const remoteTarget = words.find(word => /^(?:[^@/\s:]+@)?[^/\s:]+:(?:\/|~|[^/])/.test(word));
    if (remoteTarget && sensitiveMarker.test(rawCommand) && !/\.pub(?:\s|$)/i.test(rawCommand)) {
      return uniqueTargets([remoteTarget.split(':')[0]]);
    }
  }

  if (command === 'gh' && lowerWords[1] === 'secret' && ['set', 'delete'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([optionValue(words, ['--repo', '-R']), words[3]]);
  }
  if (command === 'kubectl' && ['create', 'apply'].includes(lowerWords[1] ?? '') && lowerWords.includes('secret')) {
    return uniqueTargets([
      optionValue(words, ['--namespace', '-n']),
      words[lowerWords.indexOf('secret') + 1],
    ]);
  }
  if (command === 'aws' && lowerWords[1] === 'secretsmanager' && ['put-secret-value', 'create-secret', 'update-secret'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([optionValue(words, ['--secret-id', '--name'])]);
  }
  if (command === 'gcloud' && lowerWords[1] === 'secrets' && (lowerWords.includes('add') || lowerWords.includes('create'))) {
    return uniqueTargets([words[2], optionValue(words, ['--project'])]);
  }
  if (command === 'az' && lowerWords[1] === 'keyvault' && lowerWords[2] === 'secret' && lowerWords[3] === 'set') {
    return uniqueTargets([optionValue(words, ['--vault-name']), optionValue(words, ['--name'])]);
  }
  if (command === 'vault' && lowerWords[1] === 'kv' && lowerWords[2] === 'put') {
    return uniqueTargets([words[3]]);
  }
  if (command === 'doppler' && lowerWords[1] === 'secrets' && lowerWords[2] === 'set') {
    return uniqueTargets([optionValue(words, ['--project']), optionValue(words, ['--config'])]);
  }
  if (command === 'vercel' && lowerWords[1] === 'env' && lowerWords[2] === 'add') {
    return uniqueTargets([words[3], words[4], optionValue(words, ['--scope'])]);
  }
  if (command === 'fly' || command === 'flyctl') {
    if (lowerWords[1] === 'secrets' && lowerWords[2] === 'set') return uniqueTargets([optionValue(words, ['--app', '-a'])]);
  }
  if (command === 'heroku' && lowerWords[1] === 'config:set') {
    return uniqueTargets([optionValue(words, ['--app', '-a'])]);
  }
  if (command === 'railway' && lowerWords[1] === 'variables' && lowerWords[2] === 'set') {
    return uniqueTargets([optionValue(words, ['--service']), optionValue(words, ['--environment'])]);
  }
  if (command === 'netlify' && lowerWords[1] === 'env:set') {
    return uniqueTargets([optionValue(words, ['--site'])]);
  }
  if (command === 'op' && lowerWords[1] === 'item' && ['create', 'edit'].includes(lowerWords[2] ?? '')) {
    return uniqueTargets([words[3], optionValue(words, ['--vault'])]);
  }
  if (['curl', 'wget'].includes(command)) {
    const writesRemote = /(?:\s|^)(?:-d|--data(?:-raw|-binary)?|-f|--form|-t|--upload-file|-x|--request\s+(?:post|put|patch))\b/i.test(rawLower);
    const carriesCredential = /(?:\$\{?[A-Za-z0-9_]*(?:secret|token|password|key)|\.env|credential|authorization\s*:|\b(?:api[_-]?key|secret|token|password)\b\s*[=:])/i.test(rawCommand);
    const credentialHeaderOrOption = /(?:authorization|x-api-key|x-auth-token|x-access-token)\s*:|(?:^|\s)(?:-u|--user|--cert|--key)(?:=|\s)/i.test(rawCommand);
    if ((writesRemote && carriesCredential) || credentialHeaderOrOption) {
      const destination = words.find(word => /^https?:\/\//i.test(word));
      return uniqueTargets([safeHttpHost(destination) ?? UNRESOLVED_EXTERNAL_TARGET]);
    }
  }
  return null;
}

interface HttpMutationDetails {
  method: string;
  host?: string;
  path: string;
  targets: string[];
}

export function classifyHttpMutation(words: string[]): HttpMutationDetails | null {
  const command = basename(words[0] ?? '');
  if (command !== 'curl' && command !== 'wget') return null;
  let mutating = false;
  let forceGet = false;
  let method: string | undefined;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '-K' || word === '--config' || word.startsWith('--config=')) mutating = true;
    if (word === '-G' || word === '--get') forceGet = true;
    if (word === '-X' || word === '--request' || word === '--method') {
      method = words[index + 1]?.toUpperCase();
      index += 1;
      continue;
    }
    const inlineMethod = /^(?:-X|--request=|--method=)(POST|PUT|PATCH|DELETE)$/i.exec(word)?.[1];
    if (inlineMethod) method = inlineMethod.toUpperCase();
    if (/^-[dFT](?:.|$)/.test(word)
      || /^(?:--data(?:-ascii|-binary|-raw|-urlencode)?|--form(?:-string)?|--json|--upload-file|--post-data|--post-file|--body-data|--body-file)(?:=|$)/i.test(word)) {
      mutating = true;
    }
  }
  if (method && /^(?:POST|PUT|PATCH|DELETE)$/.test(method)) mutating = true;
  if (forceGet && !method) mutating = false;
  if (!mutating) return null;
  const destination = words.find(word => /^https?:\/\//i.test(word));
  let parsed: URL | undefined;
  try { if (destination) parsed = new URL(destination); } catch { /* fail closed below */ }
  const host = safeHttpHost(destination);
  return {
    method: method ?? (command === 'wget' || words.some(word => /^(?:-d|--data|--json|--form|--post-)/i.test(word)) ? 'POST' : 'PUT'),
    ...(host !== undefined ? { host } : {}),
    path: parsed?.pathname ?? '',
    targets: uniqueTargets([host ?? UNRESOLVED_EXTERNAL_TARGET]),
  };
}

export function httpMutationCategory(details: HttpMutationDetails): SensitiveExternalActionCategory {
  const semantic = normalizedToolAction(details.path);
  if (/(?:^|_)(?:secrets?|credentials?|tokens?|api_keys?|private_keys?)(?:_|$)/.test(semantic)) return 'secret_transfer';
  if (/(?:^|_)(?:payment_intents?|payments?|charges?|payouts?|checkout|purchases?|trades?|orders?|buy|sell)(?:_|$)/.test(semantic)) return 'payment';
  if (/(?:^|_)(?:deploy|deploys|deployment|deployments)(?:_|$)/.test(semantic)) return 'deployment';
  if (/(?:^|_)(?:restart|restarts|reboot|rollout_restart)(?:_|$)/.test(semantic)) return 'service_restart';
  if (/(?:^|_)(?:send|deliver|forward|reply|messages?|emails?|notifications?|invites?|signatures?|edoc)(?:_|$)/.test(semantic)) return 'external_send';
  if (/(?:^|_)(?:publish|posts?|comments?|issues?|pulls?|releases?|reviews?|shares?)(?:_|$)/.test(semantic)) return 'external_publication';
  return 'external_mutation';
}

export function classifyPaymentCli(words: string[]): string[] | null {
  const executable = basename(words[0] ?? '');
  const semantic = normalizedToolAction(words.slice(1).join('_'));
  if (executable === 'stripe'
    && /(?:^|_)(?:payment_intents?|payments?|charges?|payouts?|checkout)(?:_|$)/.test(semantic)) {
    return uniqueTargets([
      'stripe',
      optionValue(words, ['--account']),
      optionValue(words, ['--amount']),
      optionValue(words, ['--currency']),
      optionValue(words, ['--customer']),
    ]);
  }
  if (['alpaca', 'binance', 'broker', 'ibkr', 'trading'].includes(executable)
    && /(?:^|_)(?:trades?|orders?|buy|sell)(?:_|$)/.test(semantic)) {
    return uniqueTargets([
      optionValue(words, ['--account', '--account-id']),
      optionValue(words, ['--symbol']),
      executable,
    ]);
  }
  return null;
}
