/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { posix } from "node:path";
import { isProvablyReadOnlyShellCommand } from "../registered-observation.ts";
import { hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { BOUNDED_COMPOSE_ACTION_OPTIONS, isBoundedProjectPackageCommand, packageManagerActionIndex, remoteServiceMutationScopeTargets, sedInPlaceMutationFileOperands } from './remote-mutation-targets.ts';
import { BOUNDED_DEPLOYMENT_SCRIPT, LOCAL_PACKAGE_SCRIPT, PACKAGE_MANAGER_EXECUTABLES, hasDynamicShellExpansion, hasUnsafeRemoteInvocationMetadata, hasUnsafeRemoteWrapperChain, humanizeRemoteIdentifier, normalizeStaticRemotePath, remoteScopeFromPath } from './remote-paths.ts';
import { BOUNDED_IMPLEMENTATION_COMPOSE_ACTIONS, BOUNDED_IMPLEMENTATION_GIT_ACTIONS, BOUNDED_IMPLEMENTATION_READ_EXECUTABLES, firstCliActionIndex } from './shell-parser.ts';
import { basename } from './target-syntax.ts';
import type { AstNode } from './types.ts';

const BOUNDED_IMPLEMENTATION_FILE_MUTATORS = new Set([
  'chmod', 'cp', 'mkdir', 'mv', 'rm', 'rmdir', 'touch',
]);

function boundedImplementationSensitiveControlPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const base = posix.basename(normalized);
  return /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|deno\.jsonc?)$/u.test(normalized)
    || /(?:^|\/)(?:(?:docker-)?compose(?:[._-][^/]*)?\.ya?ml|dockerfile(?:[._-][^/]*)?)$/u.test(normalized)
    || /(?:^|\/)(?:procfile|makefile|jenkinsfile|\.gitlab-ci\.ya?ml|taskfile\.ya?ml)$/u.test(normalized)
    || /(?:^|\/)(?:\.github\/workflows|\.husky|scripts|bin)(?:\/|$)/u.test(normalized)
    || /(?:^|\/)(?:docker-entrypoint[^/]*|[^/]+\.(?:service|socket|timer|target))$/u.test(normalized)
    || /^\.env(?:\.|$)/u.test(base)
    || /(?:^|[._-])config\.(?:js|cjs|mjs|ts|cts|mts)$/u.test(base)
    || /\.(?:bash|fish|sh|zsh)$/u.test(base);
}

function boundedImplementationPath(value: string, cwd: string): boolean {
  if (!value || value.startsWith('-') || value.includes('\\')
    || hasDynamicOrGlobTargetSyntax(value) || posix.isAbsolute(value)) return false;
  const resolved = normalizeStaticRemotePath(value, cwd);
  if (!resolved || resolved === cwd || !resolved.startsWith(`${cwd}/`)) return false;
  const relative = posix.relative(cwd, resolved);
  return relative !== '.git' && !relative.startsWith('.git/')
    && !boundedImplementationSensitiveControlPath(relative);
}

function boundedImplementationTouchesGitControl(value: string, cwd: string): boolean {
  const candidate = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
  const resolved = normalizeStaticRemotePath(candidate, cwd);
  if (!resolved || !resolved.startsWith(`${cwd}/`)) return false;
  const relative = posix.relative(cwd, resolved);
  return relative === '.git' || relative.startsWith('.git/');
}

function boundedImplementationOperandEscapesCwd(value: string, cwd: string): boolean {
  const candidate = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
  if (/(?:^|\/)\.\.(?:\/|$)/u.test(candidate) || candidate.startsWith('~/')) return true;
  return posix.isAbsolute(candidate)
    && candidate !== cwd && !candidate.startsWith(`${cwd}/`);
}

function isExactBoundedParentRulesProbe(words: readonly string[]): boolean {
  return words.join('\0') === [
    'find', '..', '-maxdepth', '3', '-type', 'f', '(', '-name', 'AGENTS.md',
    '-o', '-name', 'CLAUDE.md', ')', '-print',
  ].join('\0');
}

function boundedImplementationRedirects(
  node: Record<string, unknown>,
  cwd: string,
): boolean {
  const suffix = Array.isArray(node.suffix)
    ? node.suffix as Array<Record<string, unknown>>
    : [];
  return suffix.every((item) => {
    if (item.type !== 'Redirect') return true;
    const op = (item.op as { text?: unknown } | undefined)?.text;
    const file = (item.file as { text?: unknown; expansion?: unknown[] } | undefined);
    if (typeof op !== 'string' || typeof file?.text !== 'string'
      || file.expansion?.length) return false;
    if (file.text === '/dev/null' && ['>', '>>', '<'].includes(op)) return true;
    return ['>', '>>', '<'].includes(op)
      && boundedImplementationPath(file.text, cwd);
  });
}

function boundedImplementationGitCommand(words: string[], cwd: string): boolean {
  if (words.some(word => /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word)
    || /^(?:[^/@\s]+@)?[^/:\s]+:.+/u.test(word))) return false;
  let actionIndex = 1;
  while (words[actionIndex]?.startsWith('-')) {
    if (!['--no-pager', '--paginate'].includes(words[actionIndex]!)) return false;
    actionIndex += 1;
  }
  const action = words[actionIndex]?.toLowerCase();
  if (!action || !BOUNDED_IMPLEMENTATION_GIT_ACTIONS.has(action)) return false;
  const tail = words.slice(actionIndex + 1);
  const gitOperandEscapesCwd = tail.some(word => (
    boundedImplementationOperandEscapesCwd(word, cwd)
  ));
  if (gitOperandEscapesCwd) return false;
  if (tail.some(word => /^(?:-c|--config-env|--exec-path|--git-dir|--work-tree)(?:=|$)/u.test(word)
    || /^--(?:receive-pack|upload-pack|exec|force|force-with-lease|delete|repo|repository|pathspec-from-file|ext-diff|textconv)(?:=|$)/u.test(word)
    || /^--output(?:=|$)/u.test(word)
    || /^(?:-f|--all|--mirror|--prune)$/u.test(word)
    || word === '--unsafe-paths')) return false;
  if (action === 'remote') {
    const operation = tail.find(word => !word.startsWith('-'));
    return !operation || ['get-url', 'show'].includes(operation);
  }
  if (action === 'add') {
    const operands = tail.filter(word => word !== '--' && !word.startsWith('-'));
    return operands.length > 0
      && tail.every(word => word === '--' || !word.startsWith('-'))
      && operands.every(operand => boundedImplementationPath(operand, cwd));
  }
  // Branch creation/renaming/upstream edits write refs or .git/config, while
  // --edit-description invokes an editor. The lifecycle grant needs only the
  // two read forms used to inspect the current checkout.
  if (action === 'branch') {
    return tail.length === 0
      || tail.length === 1 && tail[0] === '--show-current';
  }
  if (action === 'commit') {
    if (tail.some(word => /^(?:-e|--edit|-i|--interactive|-p|--patch|-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash|--template|--amend)(?:=|$)/u.test(word))) {
      return false;
    }
    // A message supplied on the command line prevents Git from launching an
    // editor. A bare commit therefore remains outside this automatic grant.
    return tail.some((word, index) => (
      word === '-m' || word === '--message'
        ? !!tail[index + 1]
        : /^-m.+/u.test(word) || /^--message=.+/u.test(word)
    ));
  }
  if (action === 'apply') {
    const operands = tail.filter(word => !word.startsWith('-'));
    return operands.length > 0
      && tail.every(word => !word.startsWith('-') || ['--3way', '--check', '--index'].includes(word))
      && operands.every(operand => boundedImplementationPath(operand, cwd));
  }
  if (action === 'push' || action === 'fetch') {
    const allowedFlags = action === 'push'
      ? new Set(['--atomic', '--dry-run', '--porcelain'])
      : new Set<string>();
    if (tail.some(word => word.startsWith('-') && !allowedFlags.has(word))) return false;
    const positionals = tail.filter(word => !word.startsWith('-'));
    if (action === 'fetch') return positionals.length === 1 && positionals[0] === 'origin';
    return positionals.length === 2 && positionals[0] === 'origin'
      && positionals[1] === 'HEAD';
  }
  return true;
}

function boundedImplementationPackageTestArguments(words: string[], cwd: string): boolean {
  return words.length > 0 && words.every(word => (
    ['--', '--run', '--runInBand', '--passWithNoTests'].includes(word)
    || boundedImplementationPath(word, cwd)
  ));
}

function boundedImplementationPackageCommand(words: string[], cwd: string): boolean {
  if (isBoundedProjectPackageCommand(words) !== true) return false;
  if (words.some(word => /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word)
    || /^(?:--?(?:registry|prefix|cwd|dir|filter(?:-prod)?|workspace|workspaces|workspace-root|include-workspace-root|recursive|ws|project|project-dir|root|config|userconfig|globalconfig|target|environment|host|server|url|endpoint))(?:=|$)/iu.test(word)
    || /^-(?:C|F|R|T|W|r|w)(?:=.*|.+)?$/u.test(word)
    || /^(?:prod|production)$/iu.test(word))) return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = words[operationIndex]?.toLowerCase();
  if (!operation) return false;
  if (operation === 'run') {
    const script = words[operationIndex + 1];
    if (!script || !(LOCAL_PACKAGE_SCRIPT.test(script) || BOUNDED_DEPLOYMENT_SCRIPT.test(script))) return false;
    const tail = words.slice(operationIndex + 2);
    if (tail.length === 0) return true;
    return /^(?:test|check)(?:$|[:-])/iu.test(script)
      && boundedImplementationPackageTestArguments(tail, cwd);
  }
  if (LOCAL_PACKAGE_SCRIPT.test(operation) || BOUNDED_DEPLOYMENT_SCRIPT.test(operation)) {
    const tail = words.slice(operationIndex + 1);
    if (tail.length === 0) return true;
    return /^(?:test|check)(?:$|[:-])/iu.test(operation)
      && boundedImplementationPackageTestArguments(tail, cwd);
  }
  // Dependency restoration is bounded to the checked-out project's lockfile;
  // package-name/URL operands remain outside this compatibility grant.
  return ['ci', 'install'].includes(operation)
    && words.slice(operationIndex + 1).length === 1
    && words[operationIndex + 1] === '--ignore-scripts';
}

function boundedImplementationComposeCommand(words: string[], cwd: string): boolean {
  if (!['docker', 'podman'].includes(words[0] ?? '') || words[1] !== 'compose') return false;
  let actionIndex = 2;
  let externalComposeFile = false;
  if (words[actionIndex] === '-f' || words[actionIndex] === '--file') {
    externalComposeFile = words[actionIndex + 1] === '/srv/workspace/docker-compose.apps.yml'
      && cwd === '/srv/workspace/zero';
    if (!externalComposeFile) return false;
    actionIndex += 2;
  } else if (words[actionIndex]?.startsWith('--file=')) {
    externalComposeFile = words[actionIndex] === '--file=/srv/workspace/docker-compose.apps.yml'
      && cwd === '/srv/workspace/zero';
    if (!externalComposeFile) return false;
    actionIndex += 1;
  }
  const action = words[actionIndex]?.toLowerCase();
  if (!action || !BOUNDED_IMPLEMENTATION_COMPOSE_ACTIONS.has(action)) return false;
  const actionTail = words.slice(actionIndex + 1);
  if (actionTail.some(word => /^(?:-H|--host|--context|-f|--file|-p|--project-name|--project-directory|--env-file|--profile)(?:=|$)/u.test(word)
    || /^--push$/u.test(word)
    || /(?:^|=)(?:https?|ssh|git):\/\//iu.test(word))) return false;
  const readActionOptions = new Map<string, ReadonlySet<string>>([
    ['config', new Set(['--hash', '--images', '--no-interpolate', '--profiles', '--quiet', '--services', '--volumes'])],
    ['images', new Set(['--quiet'])],
    ['logs', new Set(['--no-color', '--timestamps'])],
    ['ls', new Set(['--all', '--quiet'])],
    ['ps', new Set(['--all', '--quiet', '--services'])],
    ['top', new Set([])],
    ['version', new Set([])],
  ]);
  const allowedOptions = BOUNDED_COMPOSE_ACTION_OPTIONS.get(action)
    ?? readActionOptions.get(action);
  if (!allowedOptions || actionTail.some(word => word.startsWith('-')
    && !allowedOptions.has(word))) return false;
  if (action === 'up' && !actionTail.some(word => word === '-d' || word === '--detach')) {
    return false;
  }
  if (externalComposeFile) {
    if (!['build', 'logs', 'ps', 'pull', 'restart', 'start', 'stop', 'up'].includes(action)) return false;
    const services = actionTail.filter(word => !word.startsWith('-'));
    if (services.length !== 1 || services[0] !== 'zero') return false;
  }
  return true;
}

function boundedImplementationFileMutation(words: string[], cwd: string): boolean {
  const executable = words[0]!;
  let operands: string[] = [];
  if (executable === 'chmod') {
    const modeIndex = words.findIndex((word, index) => index > 0 && /^[0-7]{3,4}$/u.test(word));
    if (modeIndex < 0) return false;
    operands = words.slice(modeIndex + 1);
  } else {
    const allowedOptions = new Set([
      '--', '--force', '--parents', '--recursive', '-R', '-a', '-f', '-fr', '-p', '-r', '-rf',
    ]);
    if (words.slice(1).some(word => word.startsWith('-') && !allowedOptions.has(word))) return false;
    operands = words.slice(1).filter(word => !word.startsWith('-'));
  }
  if (operands.length === 0) return false;
  if (['cp', 'mv'].includes(executable) && operands.length < 2) return false;
  return operands.every(operand => boundedImplementationPath(operand, cwd));
}

function boundedImplementationSimpleCommand(words: string[], cwd: string): boolean {
  if (words.length === 0 || hasUnsafeRemoteWrapperChain(words)) return false;
  const executable = words[0]!;
  if (executable !== basename(executable)) return false;
  if (executable === 'set') {
    return words.slice(1).every((word, index, tail) => (
      /^[-+](?:e|u|eu|ue)$/u.test(word)
      || word === '-o' && tail[index + 1] === 'pipefail'
      || word === 'pipefail' && tail[index - 1] === '-o'
    ));
  }
  if (BOUNDED_IMPLEMENTATION_READ_EXECUTABLES.has(executable)) {
    if (executable === 'find' && words.some(word => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/u.test(word))) return false;
    if (executable === 'rg' && words.some(word => /^--(?:pre|config|hostname-bin)(?:-|=|$)/u.test(word))) return false;
    if (executable === 'date' && words.some(word => word === '-s' || /^--set(?:=|$)/u.test(word))) return false;
    if (executable === 'sort' && words.some(word => /^-o.+/u.test(word)
      || word === '-o' || /^--(?:output|compress-program)(?:=|$)/u.test(word))) return false;
    if (executable === 'jq') {
      if (words.slice(1).some(word => /(?:^|[^A-Za-z0-9_])(?:\$ENV|env)(?:[^A-Za-z0-9_]|$)/iu.test(word)
        || /^(?:-f(?:.+)?|--from-file(?:=|$)|-L(?:.+)?|--library-path(?:=|$))/u.test(word))) return false;
      for (let index = 1; index < words.length; index += 1) {
        const word = words[index]!;
        if (['--rawfile', '--slurpfile', '--argfile'].includes(word)) {
          const path = words[index + 2];
          if (!path || !boundedImplementationPath(path, cwd)) return false;
          index += 2;
          continue;
        }
        const attached = /^(?:--rawfile|--slurpfile|--argfile)=(.+)$/u.exec(word)?.[1];
        if (attached && !boundedImplementationPath(attached, cwd)) return false;
      }
    }
    if (!isExactBoundedParentRulesProbe(words)
      && words.slice(1).some(word => word !== '/dev/null'
        && (boundedImplementationOperandEscapesCwd(word, cwd)
          || boundedImplementationTouchesGitControl(word, cwd)))) return false;
    return true;
  }
  if (executable === 'sed') {
    if (words.slice(1).some(word => /^(?:-f(?:.+)?|--file(?:=|$))/u.test(word))) return false;
    const mutationOperands = sedInPlaceMutationFileOperands(words);
    if (mutationOperands !== undefined) {
      return mutationOperands.length > 0
        && mutationOperands.every(operand => boundedImplementationPath(operand, cwd));
    }
    return !words.slice(1).some(word => boundedImplementationOperandEscapesCwd(word, cwd)
        || boundedImplementationTouchesGitControl(word, cwd))
      && isProvablyReadOnlyShellCommand(words.join(' '));
  }
  if (executable === 'git') return boundedImplementationGitCommand(words, cwd);
  if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
    return boundedImplementationPackageCommand(words, cwd);
  }
  if (executable === 'docker' || executable === 'podman') {
    return boundedImplementationComposeCommand(words, cwd);
  }
  if (BOUNDED_IMPLEMENTATION_FILE_MUTATORS.has(executable)) {
    return boundedImplementationFileMutation(words, cwd);
  }
  if (executable === 'systemctl' || executable === 'service') {
    const serviceAction = executable === 'systemctl'
      ? words[firstCliActionIndex(words, 1)]?.toLowerCase()
      : words[2]?.toLowerCase();
    if (!serviceAction || !['reload', 'restart', 'start'].includes(serviceAction)) return false;
    const project = remoteScopeFromPath(cwd);
    const targets = remoteServiceMutationScopeTargets(words);
    return !!project && !!targets && targets.length > 0
      && targets.every(target => humanizeRemoteIdentifier(target) === project);
  }
  return false;
}

function boundedImplementationHasOutputRedirect(node: Record<string, unknown>): boolean {
  const suffix = Array.isArray(node.suffix)
    ? node.suffix as Array<Record<string, unknown>>
    : [];
  return suffix.some((item) => {
    if (item.type !== 'Redirect') return false;
    const op = (item.op as { text?: unknown } | undefined)?.text;
    const file = (item.file as { text?: unknown } | undefined)?.text;
    return (op === '>' || op === '>>') && file !== '/dev/null';
  });
}

function boundedImplementationWritesProjectFiles(
  words: string[],
  node: Record<string, unknown>,
): boolean {
  if (boundedImplementationHasOutputRedirect(node)) return true;
  const executable = words[0];
  if (executable === 'sed' && sedInPlaceMutationFileOperands(words) !== undefined) return true;
  if (executable && BOUNDED_IMPLEMENTATION_FILE_MUTATORS.has(executable)) return true;
  if (executable === 'git') {
    const action = words.slice(1).find(word => !word.startsWith('-'))?.toLowerCase();
    return action === 'apply' || action === 'pull';
  }
  if (executable && PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
    const operationIndex = packageManagerActionIndex(words);
    const operation = words[operationIndex]?.toLowerCase();
    return operation === 'ci' || operation === 'install';
  }
  return false;
}

function boundedImplementationInvokesMutableRuntime(words: string[]): boolean {
  const executable = words[0];
  if (executable === 'docker' || executable === 'podman'
    || executable === 'systemctl' || executable === 'service') return true;
  if (!executable || !PACKAGE_MANAGER_EXECUTABLES.has(executable)) return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = words[operationIndex]?.toLowerCase();
  return !!operation && operation !== 'ci' && operation !== 'install';
}

/** Prove the whole rbw shell graph, not merely the sensitive leaf selected by
 * the category merger. This prevents an allowed deploy/edit command from
 * hiding a second database, network, mail or interpreter side effect. */
export function isBoundedRemoteImplementationLifecycleCommand(command: string, cwd: string): boolean {
  if (!command || !posix.isAbsolute(cwd) || posix.normalize(cwd) !== cwd) return false;
  let ast: AstNode;
  try {
    ast = bashParser(command) as AstNode;
  } catch {
    return false;
  }
  if (hasDynamicShellExpansion(ast) || hasUnsafeRemoteInvocationMetadata(ast)) return false;
  const validatedCommands: Array<{ words: string[]; node: Record<string, unknown> }> = [];
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    if (record.async === true) return false;
    if (record.type === 'Script' || record.type === 'Pipeline') {
      return Array.isArray(record.commands) && record.commands.length > 0
        && record.commands.every(visit);
    }
    if (record.type === 'LogicalExpression') {
      return (record.op === 'and' || record.op === 'or')
        && visit(record.left) && visit(record.right);
    }
    if (record.type !== 'Command' || Array.isArray(record.prefix) && record.prefix.length > 0
      || !boundedImplementationRedirects(record, cwd)) return false;
    const name = record.name as { text?: unknown; expansion?: unknown[] } | undefined;
    if (typeof name?.text !== 'string' || name.expansion?.length) return false;
    const words = [name.text];
    for (const rawSuffix of Array.isArray(record.suffix) ? record.suffix : []) {
      const suffix = rawSuffix as { type?: unknown; text?: unknown; expansion?: unknown[] };
      if (suffix.type === 'Redirect') continue;
      if (suffix.type !== 'Word' || typeof suffix.text !== 'string' || suffix.expansion?.length) return false;
      words.push(suffix.text);
    }
    if (!boundedImplementationSimpleCommand(words, cwd)) return false;
    validatedCommands.push({ words, node: record });
    return true;
  };
  if (!visit(ast)) return false;
  // A per-leaf allowlist is insufficient when an earlier leaf rewrites the
  // manifest/config/script consumed by a later package, compose, or service
  // command. Split those steps into separately checked calls instead of
  // granting an opaque self-reprogramming graph.
  return !(validatedCommands.some(command => (
    boundedImplementationWritesProjectFiles(command.words, command.node)
  )) && validatedCommands.some(command => (
    boundedImplementationInvokesMutableRuntime(command.words)
  )));
}
