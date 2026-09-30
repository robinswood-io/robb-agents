/// <reference path="../bash-parser.d.ts" />

import bashParser from 'bash-parser';

export type SensitiveExternalActionCategory =
  | 'git_push'
  | 'deployment'
  | 'service_restart'
  | 'secret_transfer'
  | 'external_send'
  | 'external_publication'
  | 'payment';

export interface SensitiveExternalAction {
  category: SensitiveExternalActionCategory;
  promptType: 'bash' | 'mcp_mutation' | 'api_mutation';
  description: string;
  commandPreview: string;
  reason: string;
  impact: string;
  targetCandidates: string[];
}

interface AstNode {
  type: string;
  commands?: AstNode[];
  left?: AstNode;
  right?: AstNode;
  list?: AstNode;
  name?: { type: string; text: string };
  suffix?: Array<{ type: string; text?: string }>;
}

const ACTION_DETAILS: Record<SensitiveExternalActionCategory, {
  description: string;
  reason: string;
  impact: string;
  authorizationTermGroups: string[][];
}> = {
  git_push: {
    description: 'Push commits to a remote Git repository',
    reason: 'A push changes a remote repository and requires explicit authorization for its target.',
    impact: 'Remote branches, reviews, or deployment automation may be changed or triggered.',
    authorizationTermGroups: [['push', 'pousse', 'pousser']],
  },
  deployment: {
    description: 'Deploy to an external environment',
    reason: 'A deployment changes a remote environment and requires explicit authorization for its target.',
    impact: 'Production or another shared environment may be modified and users may be affected.',
    authorizationTermGroups: [['deploy', 'deployment', 'deploie', 'deployer', 'publie la version', 'release']],
  },
  service_restart: {
    description: 'Restart an external service',
    reason: 'Restarting a service can interrupt availability and requires explicit authorization for the service.',
    impact: 'Active requests or users may experience downtime or partial failure.',
    authorizationTermGroups: [['restart', 'redemarre', 'redemarrer', 'relance', 'relancer']],
  },
  secret_transfer: {
    description: 'Transfer or write a secret to an external system',
    reason: 'Moving credentials outside local secure storage requires explicit authorization for the destination.',
    impact: 'A credential may be disclosed, persisted remotely, or grant access to production resources.',
    authorizationTermGroups: [
      ['copy', 'copie', 'copier', 'transfer', 'transfere', 'transferer', 'write', 'ecris', 'ecrire', 'set', 'configure', 'ajoute', 'ajouter', 'upload'],
      ['secret', 'credential', 'identifiant', 'token', 'api key', 'cle', 'private key', 'mot de passe'],
    ],
  },
  external_send: {
    description: 'Send content to an external recipient',
    reason: 'Sending content acts on an external audience and requires explicit authorization for the recipient.',
    impact: 'A message, email, invitation, or notification will be delivered outside this chat.',
    authorizationTermGroups: [['send', 'envoie', 'envoyer', 'reply to', 'reponds', 'repondre a', 'forward', 'transmets', 'transmettre']],
  },
  external_publication: {
    description: 'Publish content to an external audience',
    reason: 'Publishing content changes an external system and requires explicit authorization for the audience or target.',
    impact: 'A post, comment, issue, review, release, or shared resource may become visible to others.',
    authorizationTermGroups: [[
      'publish', 'publie', 'publier', 'post', 'poste', 'poster', 'add comment', 'ajoute un commentaire',
      'commente', 'comment on', 'share', 'partage', 'create issue', 'cree une issue', 'open issue',
      'ouvre une issue', 'create pull request', 'cree une pull request', 'merge pull request',
      'fusionne la pull request', 'submit review', 'publie la release',
    ]],
  },
  payment: {
    description: 'Submit a payment or financial transaction',
    reason: 'A financial submission requires explicit authorization for the recipient, account, or instrument.',
    impact: 'Funds, an order, a trade, or another financial commitment may be created or transferred.',
    authorizationTermGroups: [[
      'pay', 'paie', 'payer', 'make payment', 'effectue le paiement', 'purchase', 'buy', 'achete',
      'acheter', 'transfer funds', 'financial transfer', 'virement', 'charge card', 'charge customer',
      'place order', 'passe la commande', 'execute trade', 'sell', 'vendre',
    ]],
  },
};

const TARGET_FIELD_NAMES = new Set([
  'to',
  'recipient',
  'recipients',
  'recipient_email',
  'recipient_emails',
  'email',
  'emails',
  'channel',
  'channel_id',
  'audience',
  'target',
  'destination',
  'repo',
  'repository',
  'environment',
  'service',
  'project',
  'account',
  'account_id',
  'merchant',
  'customer',
  'customer_id',
  'user',
  'username',
  'team',
  'organization',
  'org',
  'room',
  'thread',
  'host',
  'remote',
  'branch',
  'app',
  'application',
  'namespace',
  'symbol',
]);

const TARGET_STOP_WORDS = new Set([
  'api', 'app', 'com', 'create', 'email', 'emails', 'external', 'github', 'http', 'https',
  'message', 'messages', 'net', 'org', 'payment', 'payments', 'post', 'posts',
  'release', 'releases', 'repo', 'repos', 'service', 'send', 'the',
  'this', 'user', 'users', 'www',
]);

const GENERIC_CONTINUATIONS = new Set([
  'continue',
  'continue please',
  'please continue',
  'proceed',
  'please proceed',
  'go ahead',
  'carry on',
  'resume',
  'poursuis',
  'poursuivez',
  'continuez',
  'vas y',
  'allez y',
  'reprends',
]);

const NON_AUTHORIZING_QUESTION_PREFIX = /^(?:how|what|why|when|where|who|which|can (?:i|we|you)|could (?:i|we|you)|would (?:i|we|you)|should (?:i|we|you)|do (?:i|we|you)|does|did|will (?:i|we|you)|comment|pourquoi|quand|ou|qui|quel|quelle|peux tu|pouvez vous|dois je|est ce|faut il)\b/;
const NON_AUTHORIZING_INFORMATION_PREFIX = /^(?:analy[sz]e|analyser|assess|evaluate|evalue|evaluer|review|inspect|inspecte|inspecter|explain|explique|expliquer|describe|decris|decrire|summarize|resume|resumer|investigate|examine|examiner|compare|comparer|show me|montre moi|tell me|dis moi|give me|donne moi|plan|planifie|planifier|propose|document|documente)\b/;
const NON_AUTHORIZING_NEGATION = /\b(?:not|never|without|don t|no|pas|jamais|sans|aucun|aucune)\b/;

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? value.toLowerCase();
}

function uniqueTargets(values: Array<string | undefined>): string[] {
  const targets = values
    .map(value => value?.trim())
    .filter((value): value is string =>
      typeof value === 'string' && value.length > 0 && value.length <= 200
    );
  return [...new Set(targets)].slice(0, 12);
}

function extractInputTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || targets.length >= 12 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    for (const [rawKey, entry] of Object.entries(value)) {
      const key = rawKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      if (TARGET_FIELD_NAMES.has(key)) {
        if (typeof entry === 'string') targets.push(entry);
        if (Array.isArray(entry)) {
          for (const item of entry) {
            if (typeof item === 'string') targets.push(item);
          }
        }
      }
      visit(entry, depth + 1);
    }
  };

  visit(input, 0);
  return uniqueTargets(targets);
}

function collectSimpleCommands(node: AstNode | undefined, result: string[][]): void {
  if (!node) return;
  if (node.type === 'Command') {
    const words: string[] = [];
    if (node.name?.text) words.push(node.name.text);
    for (const suffix of node.suffix ?? []) {
      if (suffix.type === 'Word' && typeof suffix.text === 'string') words.push(suffix.text);
    }
    if (words.length > 0) result.push(words);
    return;
  }
  if (node.left) collectSimpleCommands(node.left, result);
  if (node.right) collectSimpleCommands(node.right, result);
  if (node.list) collectSimpleCommands(node.list, result);
  for (const command of node.commands ?? []) collectSimpleCommands(command, result);
}

function parseSimpleCommands(command: string): string[][] {
  try {
    const ast = bashParser(command) as AstNode;
    const commands: string[][] = [];
    collectSimpleCommands(ast, commands);
    return commands;
  } catch {
    return [];
  }
}

function unwrapCommand(words: string[]): string[] {
  let current = [...words];
  for (let pass = 0; pass < 3 && current.length > 0; pass++) {
    const command = basename(current[0]!);
    if (command === 'env') {
      let index = 1;
      while (index < current.length && (current[index]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[index]!))) index += 1;
      current = current.slice(index);
      continue;
    }
    if (command === 'sudo') {
      let index = 1;
      while (index < current.length && current[index]!.startsWith('-')) {
        const option = current[index]!;
        index += 1;
        if (['-u', '--user', '-g', '--group', '-h', '--host'].includes(option) && index < current.length) index += 1;
      }
      current = current.slice(index);
      continue;
    }
    if (command === 'command' || command === 'nohup') {
      current = current.slice(1);
      continue;
    }
    break;
  }
  return current;
}

function optionValue(words: string[], names: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const equalsName = names.find(name => word.startsWith(`${name}=`));
    if (equalsName) return word.slice(equalsName.length + 1);
    if (names.includes(word) && typeof words[index + 1] === 'string') return words[index + 1];
  }
  return undefined;
}

function findSshHostIndex(words: string[]): number {
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

function positionalAfter(words: string[], actionIndex: number): string[] {
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

function redactCommandPreview(command: string, category: SensitiveExternalActionCategory): string {
  if (category === 'secret_transfer') return '[Sensitive credential operation — values redacted]';
  return command
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*["']?)[^\s,"'};]+/gi, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|secret|password)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeHttpHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

function makeAction(
  category: SensitiveExternalActionCategory,
  promptType: SensitiveExternalAction['promptType'],
  commandPreview: string,
  targetCandidates: string[],
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
  };
}

function getGitPush(words: string[]): { actionIndex: number; targets: string[] } | null {
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

function classifyDeployment(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  if (lowerWords.some(word => ['--dry-run', '--preview'].includes(word))) return null;

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
  } else if (command === 'kubectl' && ['apply', 'replace'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
  } else if (command === 'helm' && ['install', 'upgrade'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
  } else if (command === 'terraform' && lowerWords[1] === 'apply') {
    actionIndex = 1;
  } else if (command === 'docker' && lowerWords[1] === 'stack' && lowerWords[2] === 'deploy') {
    actionIndex = 2;
  } else if (command === 'docker' && lowerWords[1] === 'compose') {
    // `compose up` may create or recreate a shared service. Options such as
    // `--profile` can appear before the action (as in the audited prod command).
    actionIndex = lowerWords.findIndex((word, index) => index > 1 && word === 'up');
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
    targets: uniqueTargets([...namedTargets, ...positionalAfter(words, actionIndex).slice(0, 2)]),
  };
}

function isRemotePythonSecretWrite(command: string): boolean {
  return /\bpython(?:[0-9.]+)?\b/i.test(command)
    && /\.write_(?:text|bytes)\s*\(/i.test(command)
    && /\.env\.prod\b/i.test(command)
    && /(?:NIGHT_AGENT_API_KEY|api[_-]?key|secret|credential|token|password|private[_-]?key)/i.test(command);
}

function classifyRestart(words: string[]): { actionIndex: number; targets: string[] } | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  let actionIndex = -1;
  let targetStart = -1;

  if (command === 'systemctl' && ['restart', 'try-restart'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
    targetStart = 2;
  } else if (command === 'service' && lowerWords[2] === 'restart') {
    actionIndex = 2;
    targetStart = 1;
  } else if (command === 'docker' && lowerWords[1] === 'restart') {
    actionIndex = 1;
    targetStart = 2;
  } else if (command === 'docker' && lowerWords[1] === 'compose' && lowerWords[2] === 'restart') {
    actionIndex = 2;
    targetStart = 3;
  } else if (['pm2', 'supervisorctl'].includes(command) && ['restart', 'reload'].includes(lowerWords[1] ?? '')) {
    actionIndex = 1;
    targetStart = 2;
  } else if (command === 'kubectl' && lowerWords[1] === 'rollout' && lowerWords[2] === 'restart') {
    actionIndex = 2;
    targetStart = 3;
  } else if (command === 'brew' && lowerWords[1] === 'services' && lowerWords[2] === 'restart') {
    actionIndex = 2;
    targetStart = 3;
  } else if (command === 'launchctl' && lowerWords[1] === 'kickstart') {
    actionIndex = 1;
    targetStart = 2;
  }
  if (actionIndex < 0) return null;
  return {
    actionIndex,
    targets: uniqueTargets(words.slice(targetStart).filter(word => !word.startsWith('-')).slice(0, 2)),
  };
}

function classifySecretWrite(words: string[], rawCommand: string): string[] | null {
  const command = basename(words[0] ?? '');
  const lowerWords = words.map(word => word.toLowerCase());
  const rawLower = rawCommand.toLowerCase();
  const sensitiveMarker = /(?:^|[/_.-])(?:\.env|secret|credential|api[_-]?key|private[_-]?key|id_rsa|id_ed25519)(?:$|[/_.-])/i;

  if (['scp', 'rsync', 'sftp'].includes(command)) {
    const remoteTarget = words.find(word => /(?:^|[^:])@[^:]+:/.test(word) || /^[^/\s]+:[^/]/.test(word));
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
    if (writesRemote && /(?:\$\{?[A-Za-z0-9_]*(?:secret|token|password|key)|\.env|credential|authorization\s*:)/i.test(rawCommand)) {
      const destination = words.find(word => /^https?:\/\//i.test(word));
      return uniqueTargets([safeHttpHost(destination)]);
    }
  }
  return null;
}

function classifyBash(input: Record<string, unknown>): SensitiveExternalAction | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;

  const inspectWords = (rawWords: string[], inheritedTargets: string[] = []): SensitiveExternalAction | null => {
    const words = unwrapCommand(rawWords);
    if (words.length === 0) return null;
    const executable = basename(words[0]!);

    if (['bash', 'sh', 'zsh'].includes(executable)) {
      const commandFlagIndex = words.findIndex(word => word === '-c' || word === '-lc');
      const nested = commandFlagIndex >= 0 ? words[commandFlagIndex + 1] : undefined;
      if (nested) {
        for (const nestedWords of parseSimpleCommands(nested)) {
          const action = inspectWords(nestedWords, inheritedTargets);
          if (action) return action;
        }
      }
      return null;
    }

    if (executable === 'ssh') {
      const hostIndex = findSshHostIndex(words);
      const host = hostIndex >= 0 ? words[hostIndex] : undefined;
      const remoteCommand = hostIndex >= 0 ? words.slice(hostIndex + 1).join(' ') : '';
      if (remoteCommand) {
        if (isRemotePythonSecretWrite(remoteCommand)) {
          return makeAction(
            'secret_transfer',
            'bash',
            redactCommandPreview(command, 'secret_transfer'),
            uniqueTargets([...inheritedTargets, host]),
          );
        }
        for (const nestedWords of parseSimpleCommands(remoteCommand)) {
          const action = inspectWords(nestedWords, uniqueTargets([...inheritedTargets, host]));
          if (action) return action;
        }
      }
    }

    const gitPush = getGitPush(words);
    if (gitPush) {
      return makeAction('git_push', 'bash', redactCommandPreview(command, 'git_push'), uniqueTargets([...inheritedTargets, ...gitPush.targets]));
    }

    const deployment = classifyDeployment(words);
    if (deployment) {
      return makeAction('deployment', 'bash', redactCommandPreview(command, 'deployment'), uniqueTargets([...inheritedTargets, ...deployment.targets]));
    }

    const restart = classifyRestart(words);
    if (restart) {
      return makeAction('service_restart', 'bash', redactCommandPreview(command, 'service_restart'), uniqueTargets([...inheritedTargets, ...restart.targets]));
    }

    const secretTargets = classifySecretWrite(words, command);
    if (secretTargets) {
      return makeAction('secret_transfer', 'bash', redactCommandPreview(command, 'secret_transfer'), uniqueTargets([...inheritedTargets, ...secretTargets]));
    }

    return null;
  };

  for (const words of parseSimpleCommands(command)) {
    const action = inspectWords(words);
    if (action) return action;
  }
  return null;
}

function normalizedToolAction(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

const READ_ONLY_ACTION_TOKENS = new Set([
  'check',
  'count',
  'describe',
  'fetch',
  'find',
  'get',
  'health',
  'inspect',
  'list',
  'lookup',
  'preflight',
  'preview',
  'query',
  'read',
  'resolve',
  'search',
  'status',
  'validate',
  'verify',
]);

const MUTATING_ACTION_TOKENS = new Set([
  'add',
  'buy',
  'charge',
  'checkout',
  'copy',
  'create',
  'deliver',
  'deploy',
  'deployment',
  'execute',
  'forward',
  'merge',
  'pay',
  'payment',
  'place',
  'post',
  'publish',
  'purchase',
  'put',
  'reply',
  'restart',
  'sell',
  'send',
  'set',
  'share',
  'store',
  'submit',
  'transfer',
  'update',
  'upload',
]);

const COMPOUND_ACTION_TOKENS = new Set(['after', 'and', 'before', 'then']);

/**
 * Detect explicit read-only semantics before looking for mutation keywords.
 *
 * Source tool names often include the operation they inspect, for example
 * `gmail_send_preflight` or `get_send_status`. Looking for `send` alone turns
 * those reads into false-positive external mutations. Preflight/dry-run names
 * are unconditionally non-executing; otherwise the first semantic verb wins,
 * except for explicit compound actions such as `verify_and_send`.
 */
function isClearlyReadOnlyToolAction(action: string): boolean {
  const tokens = action.split('_').filter(Boolean);

  const explicitReadOnlyIndex = tokens.findIndex((token, index) =>
    token === 'preflight'
    || token === 'dryrun'
    || (token === 'dry' && tokens[index + 1] === 'run')
  );
  if (explicitReadOnlyIndex >= 0) {
    const laterMutationIndex = tokens.findIndex((token, index) =>
      index > explicitReadOnlyIndex && MUTATING_ACTION_TOKENS.has(token)
    );
    if (laterMutationIndex < 0) return true;
    if (!tokens
      .slice(explicitReadOnlyIndex + 1, laterMutationIndex)
      .some(token => COMPOUND_ACTION_TOKENS.has(token))) return true;
  }

  const firstIntentIndex = tokens.findIndex(token =>
    READ_ONLY_ACTION_TOKENS.has(token) || MUTATING_ACTION_TOKENS.has(token)
  );
  if (firstIntentIndex < 0 || !READ_ONLY_ACTION_TOKENS.has(tokens[firstIntentIndex]!)) return false;

  const laterMutationIndex = tokens.findIndex((token, index) =>
    index > firstIntentIndex && MUTATING_ACTION_TOKENS.has(token)
  );
  if (laterMutationIndex < 0) return true;

  // `get_send_status` is a read, whereas `verify_and_send` is a compound
  // mutation. Keep the latter fail-closed.
  return !tokens
    .slice(firstIntentIndex + 1, laterMutationIndex)
    .some(token => COMPOUND_ACTION_TOKENS.has(token));
}

function classifyMcp(toolName: string, input: Record<string, unknown>): SensitiveExternalAction | null {
  if (toolName.startsWith('mcp__session__') || toolName.startsWith('mcp__craft-agents-docs__')) return null;
  if (toolName.includes('__api_')) return classifyApi(toolName, input);

  const action = normalizedToolAction(toolName.split('__').slice(2).join('_'));
  if (isClearlyReadOnlyToolAction(action)) return null;
  const targets = extractInputTargets(input);
  const make = (category: SensitiveExternalActionCategory) =>
    makeAction(category, 'mcp_mutation', toolName, targets);

  if (/(?:^|_)(?:set|put|create|update|upload|add|store|copy|transfer)_(?:[^_]+_)*(?:secret|credential|token|api_key|private_key)(?:_|$)/.test(action)
    || /(?:^|_)(?:secret|credential|token|api_key|private_key)_(?:set|put|create|update|upload|add|store|copy|transfer)(?:_|$)/.test(action)) return make('secret_transfer');
  if (/(?:^|_)(?:pay|payment|charge|purchase|checkout|payout|financial_transfer|place_order|execute_trade|buy|sell)(?:_|$)/.test(action)
    || /(?:^|_)(?:create|place|submit|execute)_(?:payment|charge|purchase|checkout|payout|transfer|order|trade)(?:_|$)/.test(action)) return make('payment');
  if (/(?:^|_)(?:deploy|deployment)(?:_|$)/.test(action)) return make('deployment');
  if (/(?:^|_)(?:restart|restart_service|rollout_restart)(?:_|$)/.test(action)) return make('service_restart');
  if (/(?:^|_)git_push(?:_|$)/.test(action)) return make('git_push');
  if (/(?:^|_)(?:send|deliver|forward|reply)(?:_|$)/.test(action)) return make('external_send');
  if (/(?:^|_)(?:publish|share|make_public)(?:_|$)/.test(action)
    || /(?:^|_)(?:create|add|post|submit|merge)_(?:post|comment|issue|pull_request|release|review|announcement)(?:_|$)/.test(action)) return make('external_publication');
  return null;
}

function pathTargets(path: string | undefined): string[] {
  if (!path) return [];
  const genericSegments = new Set([
    'api', 'v1', 'v2', 'v3', 'repos', 'messages', 'emails', 'posts', 'comments', 'issues',
    'pulls', 'releases', 'payments', 'charges', 'transfers', 'orders', 'trades', 'secrets',
    'credentials', 'tokens', 'deployments', 'restart', 'send', 'publish',
  ]);
  const segments = path
    .split(/[/?#]/)
    .map(segment => segment.trim())
    .filter(segment => segment && !genericSegments.has(segment.toLowerCase()) && !/^\d+$/.test(segment));
  return segments.length > 0 ? [segments.slice(-2).join(' ')] : [];
}

function classifyApi(toolName: string, input: Record<string, unknown>): SensitiveExternalAction | null {
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const path = typeof input.path === 'string' ? input.path : '';
  const operation = typeof input.operation === 'string' ? input.operation : '';
  if (path && isClearlyReadOnlyToolAction(normalizedToolAction(path))) return null;
  const semantic = normalizedToolAction(`${toolName}_${operation}_${path}`);
  const targets = uniqueTargets([...extractInputTargets(input), ...pathTargets(path)]);
  const preview = `${method} ${path || toolName}`;
  const make = (category: SensitiveExternalActionCategory) =>
    makeAction(category, 'api_mutation', preview, targets);

  if (/(?:^|_)(?:secret|secrets|credential|credentials|token|tokens|api_key|api_keys)(?:_|$)/.test(semantic)) return make('secret_transfer');
  if (/(?:^|_)(?:payment|payments|charge|charges|checkout|payout|payouts|financial_transfer|transfers|purchase|orders|trade|trades|buy|sell)(?:_|$)/.test(semantic)) return make('payment');
  if (/(?:^|_)(?:deploy|deployment|deployments)(?:_|$)/.test(semantic)) return make('deployment');
  if (/(?:^|_)(?:restart|restarts)(?:_|$)/.test(semantic)) return make('service_restart');
  if (/(?:^|_)(?:send|deliver|forward|reply|messages|emails|notifications|invites)(?:_|$)/.test(semantic)) return make('external_send');
  if (/(?:^|_)(?:publish|posts|comments|issues|pulls|releases|reviews|shares)(?:_|$)/.test(semantic)) return make('external_publication');
  return null;
}

/** Classify only high-confidence external mutations; ordinary local/read actions return null. */
export function classifySensitiveExternalAction(
  toolName: string,
  input: Record<string, unknown>,
): SensitiveExternalAction | null {
  if (toolName === 'Bash') return classifyBash(input);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, input);
  if (toolName.startsWith('api_')) return classifyApi(toolName, input);
  return null;
}

function containsPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeForMatch(phrase);
  return normalizedPhrase.length > 0 && ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function targetIsNamed(normalizedRequest: string, target: string): boolean {
  const normalizedTarget = normalizeForMatch(target);
  if (!normalizedTarget) return false;
  if (` ${normalizedRequest} `.includes(` ${normalizedTarget} `)) return true;

  const requestTokens = new Set(normalizedRequest.split(' '));
  const targetTokens = normalizedTarget
    .split(' ')
    .filter(token => token.length >= 3 && !TARGET_STOP_WORDS.has(token));
  return targetTokens.length > 0 && targetTokens.every(token => requestTokens.has(token));
}

function isNonAuthorizingRequest(rawRequest: string, normalizedRequest: string): boolean {
  if (/[?？]/.test(rawRequest) || NON_AUTHORIZING_NEGATION.test(normalizedRequest)) return true;

  const withoutPoliteness = normalizedRequest.replace(
    /^(?:please|s il te plait|s il vous plait|merci de)\s+/,
    '',
  );
  return NON_AUTHORIZING_QUESTION_PREFIX.test(withoutPoliteness)
    || NON_AUTHORIZING_INFORMATION_PREFIX.test(withoutPoliteness)
    || /\b(?:how to|comment faire|instructions? (?:to|pour))\b/.test(withoutPoliteness);
}

/**
 * A current user request authorizes the action only when it explicitly names
 * both the action category and a concrete target/audience derived from the
 * tool call. Generic continuations never count as authorization.
 */
export function isSensitiveExternalActionExplicitlyAuthorized(
  action: SensitiveExternalAction,
  currentUserRequest?: string,
): boolean {
  const rawRequest = currentUserRequest ?? '';
  const normalizedRequest = normalizeForMatch(rawRequest);
  if (
    !normalizedRequest
    || GENERIC_CONTINUATIONS.has(normalizedRequest)
    || isNonAuthorizingRequest(rawRequest, normalizedRequest)
  ) return false;

  const details = ACTION_DETAILS[action.category];
  const actionNamed = details.authorizationTermGroups.every(group =>
    group.some(term => containsPhrase(normalizedRequest, term))
  );
  if (!actionNamed || action.targetCandidates.length === 0) return false;

  return action.targetCandidates.some(target => targetIsNamed(normalizedRequest, target));
}
