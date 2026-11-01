import { positionalAfter } from './action-presentation.ts';
import { uniqueTargets } from './action-targets.ts';
import { UNRESOLVED_REMOTE_SCOPE, hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { BOUNDED_DEPLOYMENT_SCRIPT, EXTERNAL_PACKAGE_OPERATIONS, LOCAL_PACKAGE_SCRIPT, PACKAGE_MANAGER_EXECUTABLES, PACKAGE_MANAGER_OPTIONS_WITH_VALUES, normalizeStaticRemotePath, pathReferences, remoteScopeFromPath } from './remote-paths.ts';
import { firstCliActionIndex, unwrapCommand } from './shell-parser.ts';
import { basename } from './target-syntax.ts';
import type { SensitiveExternalActionCategory } from './types.ts';

export function packageManagerActionIndex(words: string[]): number {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--') return index + 1 < words.length ? index + 1 : -1;
    if (!word.startsWith('-')) return index;
    const optionName = word.split('=', 1)[0]!;
    if (!word.includes('=') && PACKAGE_MANAGER_OPTIONS_WITH_VALUES.has(optionName)) index += 1;
  }
  return -1;
}

export function isBoundedProjectPackageCommand(words: string[]): boolean | undefined {
  const executable = basename(words[0] ?? '');
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return undefined;
  if (executable === 'npx') return false;
  const operationIndex = packageManagerActionIndex(words);
  const operation = operationIndex >= 0 ? words[operationIndex]?.toLowerCase() : undefined;
  if (!operation || EXTERNAL_PACKAGE_OPERATIONS.has(operation)) return false;
  if (operation === 'run') {
    const script = words.slice(operationIndex + 1).find(word => !word.startsWith('-'));
    return !!script && (LOCAL_PACKAGE_SCRIPT.test(script) || BOUNDED_DEPLOYMENT_SCRIPT.test(script));
  }
  if (LOCAL_PACKAGE_SCRIPT.test(operation) || BOUNDED_DEPLOYMENT_SCRIPT.test(operation)) return true;
  return new Set(['add', 'ci', 'install', 'link', 'remove', 'uninstall', 'update']).has(operation);
}

export function packageManagerExternalOperation(
  words: string[],
): SensitiveExternalActionCategory | undefined {
  const executable = basename(words[0] ?? '');
  if (executable === 'npx' || executable === 'bunx') return 'external_mutation';
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return undefined;
  if (isBoundedProjectPackageCommand(words) === true) return undefined;
  // Package CLIs accept global options (with separate values) before the
  // operation and several unambiguous abbreviations. Scan the complete token
  // stream conservatively instead of letting an option value impersonate the
  // action position.
  const tokens = words.slice(1).map(word => word.toLowerCase());
  if (tokens.some(token => ['pub', 'publish', 'unpub', 'unpublish'].includes(token))) {
    return 'external_publication';
  }
  return 'external_mutation';
}

const CONTAINER_MULTI_TARGET_COMMANDS = new Set([
  'kill', 'pause', 'restart', 'rm', 'start', 'stop', 'unpause', 'update', 'wait',
]);

const CONTAINER_OPTIONS_WITH_VALUES = new Set([
  '--cidfile', '--detach-keys', '--env', '--env-file', '--filter', '--format',
  '--signal', '--time', '--user', '--workdir', '-e', '-t', '-u', '-w',
]);

const BOUNDED_COMPOSE_MUTATIONS = new Set([
  'build', 'create', 'down', 'kill', 'pause', 'pull', 'restart', 'rm', 'start',
  'stop', 'unpause', 'up',
]);

export const BOUNDED_COMPOSE_ACTION_OPTIONS = new Map<string, ReadonlySet<string>>([
  // Keep the compatibility grammar deliberately small. These flags neither
  // retarget the compose project/daemon nor publish an image. Unknown flags
  // (including build --push and builder selections) remain unresolved.
  ['up', new Set(['-d', '--detach', '--no-build', '--no-deps', '--force-recreate', '--remove-orphans', '--wait'])],
  ['down', new Set(['--remove-orphans'])],
  ['restart', new Set([])],
  ['start', new Set([])],
  ['stop', new Set([])],
  ['pause', new Set([])],
  ['unpause', new Set([])],
  ['kill', new Set([])],
  ['rm', new Set(['-f', '--force', '-s', '--stop'])],
  ['create', new Set(['--no-build', '--no-recreate', '--force-recreate'])],
  ['build', new Set([])],
  ['pull', new Set([])],
]);

/**
 * Extract container identities from mutating Docker/Podman operations. A
 * project cwd is not authority over an adjacent container, so an unsupported
 * or dynamic form deliberately becomes unresolved.
 */
export function containerMutationScopeTargets(words: string[], cwd?: string): string[] | undefined {
  const executable = basename(words[0] ?? '');
  if (executable !== 'docker' && executable !== 'podman') return undefined;
  // Remote recovery admits only the default local engine. Global CLI options
  // may select another daemon, config, connection or storage root.
  if (words[1]?.startsWith('-')) return [UNRESOLVED_REMOTE_SCOPE];
  const retargeted = executable === 'docker'
    ? words.slice(1).some(word => /^(?:-H(?:.+)?|--(?:h|ho|hos|host|c|co|con|cont|conte|contex|context)(?:=|$))/.test(word))
    : words.slice(1).some(word => /^(?:-c(?:.+)?|--(?:r|re|rem|remo|remot|remote|u|ur|url|c|co|con|conn|conne|connec|connect|connecti|connectio|connection)(?:=|$))/.test(word));
  if (retargeted) return [UNRESOLVED_REMOTE_SCOPE];
  const supportedSubcommands = new Set([
    ...CONTAINER_MULTI_TARGET_COMMANDS,
    'cp', 'rename',
  ]);
  // Global options were rejected above, therefore the first token after the
  // executable must itself be the supported subcommand. Never scan through an
  // opaque nested command (for example `docker exec ... rm`) and mistake it
  // for the outer operation.
  const subcommandIndex = supportedSubcommands.has(words[1] ?? '') || words[1] === 'compose'
    ? 1
    : -1;
  if (subcommandIndex < 0) return [UNRESOLVED_REMOTE_SCOPE];
  const subcommand = words[subcommandIndex]!;
  if (subcommand === 'compose') {
    // Compose scope flags precede the action and can point at another project
    // even while cwd still names Orion. No pre-action option is needed by the
    // bounded live mutation grammar.
    const composeAction = words[subcommandIndex + 1]?.toLowerCase();
    if (!composeAction || composeAction.startsWith('-')
      || !BOUNDED_COMPOSE_MUTATIONS.has(composeAction)) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    const allowedOptions = BOUNDED_COMPOSE_ACTION_OPTIONS.get(composeAction);
    if (!allowedOptions || words.slice(subcommandIndex + 2).some(word =>
      word.startsWith('-') && !allowedOptions.has(word)
    )) return [UNRESOLVED_REMOTE_SCOPE];
    const services = words.slice(subcommandIndex + 2)
      .filter(word => !word.startsWith('-'));
    if (services.some(hasDynamicOrGlobTargetSyntax)) return [UNRESOLVED_REMOTE_SCOPE];
    // `down` is project-wide and has no service operand. Every other bounded
    // action may name services, which are part of the exact authorization
    // target rather than being allowed to disappear behind the project cwd.
    if (composeAction === 'down' && services.length > 0) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    return uniqueTargets(services);
  }

  const positional: string[] = [];
  for (let index = subcommandIndex + 1; index < words.length; index += 1) {
    const word = words[index]!;
    const optionName = word.split('=', 1)[0]!;
    if (word.startsWith('-')) {
      if (!word.includes('=') && CONTAINER_OPTIONS_WITH_VALUES.has(optionName)) index += 1;
      continue;
    }
    positional.push(word);
    if (subcommand === 'exec') break;
  }

  let identifiers: string[];
  if (subcommand === 'cp') {
    identifiers = [];
    for (const value of positional) {
      if (hasDynamicOrGlobTargetSyntax(value)) return [UNRESOLVED_REMOTE_SCOPE];
      const containerEndpoint = /^([^/:]+):(.+)$/.exec(value);
      if (containerEndpoint) {
        identifiers.push(containerEndpoint[1]!);
        continue;
      }
      const hostPath = normalizeStaticRemotePath(value, cwd);
      const hostScope = hostPath ? remoteScopeFromPath(hostPath) : undefined;
      identifiers.push(hostScope ?? UNRESOLVED_REMOTE_SCOPE);
    }
  } else if (subcommand === 'rename') {
    identifiers = positional.slice(0, 2);
  } else {
    identifiers = positional;
  }
  if (identifiers.length === 0 || identifiers.some(hasDynamicOrGlobTargetSyntax)) {
    return [UNRESOLVED_REMOTE_SCOPE];
  }
  return uniqueTargets(identifiers);
}

/** Extract only sed's in-place file operands. Programs may themselves contain
 * slash-delimited paths, but those strings are replacement data, not remote
 * scope. Unsupported/operand-free forms stay unresolved. */
export function sedInPlaceMutationFileOperands(words: string[]): string[] | undefined {
  if (basename(words[0] ?? '') !== 'sed') return undefined;
  let inPlace = false;
  let hasProgram = false;
  let optionsEnded = false;
  const programs: string[] = [];
  const files: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (word === '-i' || word === '--in-place')) {
      inPlace = true;
      if (words[index + 1] === '') index += 1; // BSD `sed -i '' ...`
      continue;
    }
    if (!optionsEnded && (/^-i.+/.test(word) || /^--in-place=/.test(word))) {
      const backupSuffix = word.startsWith('--in-place=')
        ? word.slice('--in-place='.length)
        : word.slice(2);
      if (backupSuffix.includes('/') || hasDynamicOrGlobTargetSyntax(backupSuffix)) return [];
      inPlace = true;
      continue;
    }
    if (!optionsEnded && ['-n', '--quiet', '--silent'].includes(word)) continue;
    if (!optionsEnded && ['-f', '--file'].includes(word)) return inPlace ? [] : undefined;
    if (!optionsEnded && ['-e', '--expression'].includes(word)) {
      if (typeof words[index + 1] !== 'string') return inPlace ? [] : undefined;
      hasProgram = true;
      programs.push(words[index + 1]!);
      index += 1;
      continue;
    }
    if (!optionsEnded && /^(?:-f.+|--file=)/.test(word)) return inPlace ? [] : undefined;
    if (!optionsEnded && /^(?:-e|--expression=).+/.test(word)) {
      hasProgram = true;
      programs.push(word.startsWith('-e') ? word.slice(2) : word.slice('--expression='.length));
      continue;
    }
    if (!optionsEnded && word.startsWith('-')) return inPlace ? [] : undefined;
    if (!hasProgram) {
      hasProgram = true;
      programs.push(word);
      continue;
    }
    files.push(word);
  }
  if (!inPlace) return undefined;
  const boundedSubstitution = (program: string): boolean => {
    if (!program || program.length > 4_096 || /[\r\n]/.test(program)) return false;
    return program.split(';').every(rawExpression => {
      const expression = rawExpression.trim();
      if (expression[0] !== 's') return false;
      const delimiter = expression[1];
      if (!delimiter || /[A-Za-z0-9\\\s]/.test(delimiter)) return false;
      let separators = 0;
      let escaped = false;
      let finalSeparator = -1;
      for (let index = 2; index < expression.length; index += 1) {
        const character = expression[index]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character !== delimiter) continue;
        separators += 1;
        finalSeparator = index;
      }
      if (separators !== 2 || finalSeparator < 0) return false;
      return /^[gIp0-9]*$/.test(expression.slice(finalSeparator + 1));
    });
  };
  return files.length > 0 && programs.length > 0 && programs.every(boundedSubstitution)
    ? files
    : [];
}

export function remoteServiceMutationScopeTargets(
  words: string[],
  companionServiceTargets: readonly string[] = [],
): string[] | undefined {
  const executable = basename(words[0] ?? '');
  if (executable === 'systemctl') {
    if (words[1]?.startsWith('-')) return [UNRESOLVED_REMOTE_SCOPE];
    if (words.slice(1).some(word => /^(?:-[HM](?:.+)?|--(?:h|ho|hos|host|m|ma|mac|mach|machi|machin|machine|r|ro|roo|root|i|im|ima|imag|image)(?:=|$))/.test(word))) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    // Manager selectors are meaningful even after the action (`restart
    // --user unit`). Never let positional parsing silently discard a switch
    // from the system manager authorized by the objective to another scope.
    if (words.slice(1).some(word => /^--(?:u|us|use|user|g|gl|glo|glob|globa|global|s|sy|sys|syst|syste|system)(?:=|$)/.test(word))) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    const actionIndex = firstCliActionIndex(
      words, 1, new Set(['-H', '--host', '-M', '--machine', '--root', '--image']),
    );
    const action = words[actionIndex]?.toLowerCase();
    // daemon-reload changes systemd's global manager state and names no unit.
    // It is target-neutral only inside the same static composite as an exact
    // unit mutation/file installation; standalone reloads remain unresolved.
    if (action === 'daemon-reload') {
      return companionServiceTargets.length > 0 ? [] : [UNRESOLVED_REMOTE_SCOPE];
    }
    if (!action || !new Set([
      'disable', 'enable', 'mask', 'reenable', 'reload', 'reload-or-restart',
      'reload-or-try-restart', 'restart', 'start', 'stop', 'try-restart', 'unmask',
    ]).has(action)) return [UNRESOLVED_REMOTE_SCOPE];
    const units = positionalAfter(words, actionIndex).map(unit => unit.replace(/\.service$/i, ''));
    if (units.length === 0 || units.some(hasDynamicOrGlobTargetSyntax)) {
      return [UNRESOLVED_REMOTE_SCOPE];
    }
    return uniqueTargets(units);
  }
  if (executable === 'service') {
    const unit = words[1];
    const action = words[2]?.toLowerCase();
    if (!unit || !['reload', 'restart', 'start', 'stop'].includes(action ?? '')
      || hasDynamicOrGlobTargetSyntax(unit)) return [UNRESOLVED_REMOTE_SCOPE];
    return uniqueTargets([unit.replace(/\.service$/i, '')]);
  }
  return undefined;
}

const GNU_TARGET_DIRECTORY_MUTATORS = new Set(['cp', 'install', 'ln', 'mv']);

/**
 * GNU file mutators accept a destination through `-t DIR`, `-tDIR`, and
 * `--target-directory=DIR`. The attached short form is invisible to the
 * generic path scanner (`-t/tmp`), so expose it as a real scope operand.
 */
export function fileMutationTargetDirectoryOperands(words: string[]): string[] | undefined {
  if (!GNU_TARGET_DIRECTORY_MUTATORS.has(basename(words[0] ?? ''))) return undefined;
  const targets: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (/^-[A-Za-z]*t$/.test(word) || word === '--target-directory') {
      const target = words[index + 1];
      if (!target || target.startsWith('-')) return [];
      targets.push(target);
      index += 1;
      continue;
    }
    const attachedShort = /^-[A-Za-z]*t=?(.+)$/.exec(word)?.[1];
    if (attachedShort) {
      targets.push(attachedShort);
      continue;
    }
    const attachedLong = /^--target-directory=(.+)$/.exec(word)?.[1];
    if (attachedLong) targets.push(attachedLong);
  }
  return targets;
}

/** GNU install can execute an arbitrary helper through --strip-program. Keep
 * the remotely-authorizable form to the one needed by the Orion deployment:
 * an optional literal mode followed by exactly one source and destination. */
export function installMutationFileOperands(words: string[]): string[] | undefined {
  if (words[0] !== 'install') return undefined;
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  let options = true;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && (word === '-m' || word === '--mode')) {
      const mode = words[index + 1];
      if (!mode || !/^[0-7]{3,4}$/.test(mode)) return [];
      index += 1;
      continue;
    }
    if (options && /^-m[0-7]{3,4}$/.test(word)) continue;
    if (options && /^--mode=[0-7]{3,4}$/.test(word)) continue;
    if (options && (word === '-t' || word === '--target-directory')) {
      const target = words[index + 1];
      if (!target || target.startsWith('-') || targetDirectory) return [];
      targetDirectory = target;
      index += 1;
      continue;
    }
    if (options && /^-t(.+)$/.test(word)) {
      if (targetDirectory) return [];
      targetDirectory = word.slice(2);
      continue;
    }
    if (options && /^--target-directory=(.+)$/.test(word)) {
      if (targetDirectory) return [];
      targetDirectory = word.slice('--target-directory='.length);
      continue;
    }
    if (options && word.startsWith('-')) return [];
    operands.push(word);
  }
  if (targetDirectory) return operands.length === 1 ? [...operands, targetDirectory] : [];
  return operands.length === 2 ? operands : [];
}

const SYSTEMD_UNIT_FILE_MUTATORS = new Set(['cp', 'install', 'ln', 'mv', 'tee']);

export function exactCompanionRemoteServiceTargets(commands: string[][]): string[] {
  const targets: string[] = [];
  for (const rawWords of commands) {
    const words = unwrapCommand(rawWords);
    if (words.length === 0) continue;
    const serviceTargets = remoteServiceMutationScopeTargets(words);
    if (serviceTargets) {
      targets.push(...serviceTargets.filter(target => target !== UNRESOLVED_REMOTE_SCOPE));
    }
    if (!SYSTEMD_UNIT_FILE_MUTATORS.has(basename(words[0] ?? ''))) continue;
    for (const word of words.slice(1)) {
      for (const reference of pathReferences(word)) {
        const normalized = normalizeStaticRemotePath(reference);
        const unit = normalized
          ? /^\/etc\/systemd\/system\/([^/]+)\.service$/i.exec(normalized)?.[1]
          : undefined;
        if (unit && !hasDynamicOrGlobTargetSyntax(unit)) targets.push(unit);
      }
    }
  }
  return uniqueTargets(targets);
}
