/// <reference path="../../bash-parser.d.ts" />
import bashParser from "bash-parser";
import { isProvablyReadOnlyShellCommand, isReadOnlyRegisteredShellObservation } from "../registered-observation.ts";
import { extractInputTargets, uniqueTargets } from './action-targets.ts';
import { safePermissionPromptValue } from './connector-classification.ts';
import { UNRESOLVED_EXTERNAL_TARGET, UNRESOLVED_REMOTE_SCOPE, hasDynamicOrGlobTargetSyntax } from './host-authorization.ts';
import { containerMutationScopeTargets, exactCompanionRemoteServiceTargets, fileMutationTargetDirectoryOperands, installMutationFileOperands, isBoundedProjectPackageCommand, remoteServiceMutationScopeTargets, sedInPlaceMutationFileOperands } from './remote-mutation-targets.ts';
import { PROJECT_SCOPED_REMOTE_EXECUTABLES, REMOTE_FILESYSTEM_MUTATION_EXECUTABLES, REMOTE_FILE_MUTATOR_EXECUTABLES, STATIC_REMOTE_FILE_OPERAND_PATTERN, commandFromActionInput, hasDynamicShellExpansion, hasUnsafeRemoteInvocationMetadata, hasUnsafeRemoteWrapperChain, hasUnsupportedRemoteScopeNode, normalizeStaticRemotePath, pathReferences, rawRemotePathInput, remoteCdTransitionsAreSafelyChained, remoteScopeFromPath, stringInput } from './remote-paths.ts';
import { parseSimpleCommands, unwrapCommand } from './shell-parser.ts';
import { basename } from './target-syntax.ts';

export function extractRemoteCommandScopeTargets(input: Record<string, unknown>): string[] {
  const cwd = rawRemotePathInput(input, ['cwd', 'workingDirectory', 'working_directory']);
  let effectiveCwd = cwd ? normalizeStaticRemotePath(cwd) : undefined;
  const remoteEndpoint = stringInput(input, ['server', 'host', 'hostname']);
  const remoteEndpointTarget = remoteEndpoint && remoteEndpoint.length <= 256
    && !hasDynamicOrGlobTargetSyntax(remoteEndpoint)
    && /^[A-Za-z0-9._@:-]+(?:\s+[A-Za-z0-9._@:-]+)*$/.test(remoteEndpoint)
    ? remoteEndpoint
    : undefined;
  const bindRemoteEndpoint = (targets: string[]): string[] => {
    const scoped = uniqueTargets(targets);
    return remoteEndpointTarget
      ? uniqueTargets([remoteEndpointTarget, ...scoped])
      : uniqueTargets([UNRESOLVED_EXTERNAL_TARGET, ...scoped, UNRESOLVED_REMOTE_SCOPE]);
  };
  const command = commandFromActionInput(input);
  try {
    const ast: unknown = bashParser(command);
    if (hasUnsupportedRemoteScopeNode(ast) || hasDynamicShellExpansion(ast)
      || hasUnsafeRemoteInvocationMetadata(ast)
      || !remoteCdTransitionsAreSafelyChained(ast)) {
      return bindRemoteEndpoint([
        effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined,
        UNRESOLVED_REMOTE_SCOPE,
      ].filter((target): target is string => !!target));
    }
  } catch {
    return command ? [UNRESOLVED_REMOTE_SCOPE] : extractInputTargets(input);
  }
  const commands = parseSimpleCommands(command);
  if (command && commands.length === 0) return [UNRESOLVED_REMOTE_SCOPE];
  const companionServiceTargets = exactCompanionRemoteServiceTargets(commands);

  const mutationTargets: string[] = [];
  let sawMutationCommand = false;
  let unresolvedWorkingDirectory = false;
  for (const rawWords of commands) {
    // Validate the process that performs any wrapper semantics before
    // `unwrapCommand` removes it. A project-controlled lookalike named
    // `command`, `sudo`, `time`, etc. must never inherit Orion authority.
    if (hasUnsafeRemoteWrapperChain(rawWords)) {
      sawMutationCommand = true;
      mutationTargets.push(
        effectiveCwd ? remoteScopeFromPath(effectiveCwd) ?? UNRESOLVED_REMOTE_SCOPE : UNRESOLVED_REMOTE_SCOPE,
        UNRESOLVED_REMOTE_SCOPE,
      );
      continue;
    }
    const words = unwrapCommand(rawWords);
    if (words.length === 0) continue;
    const executable = basename(words[0]!);
    // Do not authorize a project-controlled lookalike merely because its
    // basename is `touch`, `systemctl`, `docker`, etc. The bounded grammar
    // invokes PATH-resolved bare utilities only; slash-bearing executables are
    // outside this compatibility shim.
    if (words[0] !== executable) {
      sawMutationCommand = true;
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }
    if (executable === 'cd') {
      const destination = words.find((word, index) => index > 0 && !word.startsWith('-'));
      if (!destination || destination === '-' || /[$`~]/.test(destination)
        || /(?:\|\||(?<!\|)\|(?!\|))/.test(command)) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
        continue;
      }
      const resolved = normalizeStaticRemotePath(destination, effectiveCwd);
      if (!resolved) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
        continue;
      }
      effectiveCwd = resolved;
      if (!remoteScopeFromPath(effectiveCwd)) {
        mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
        unresolvedWorkingDirectory = true;
      }
      continue;
    }

    const serialized = words.join(' ');
    if (isProvablyReadOnlyShellCommand(serialized)
      || isReadOnlyRegisteredShellObservation(serialized)) continue;
    sawMutationCommand = true;
    // Once a preceding `cd` has escaped (or could not prove) the project
    // scope, later relative operands must not manufacture a new target from
    // the escaped directory basename. Shell `cd` persists across `;`/`&&`.
    if (unresolvedWorkingDirectory) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }

    const cwdTarget = effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined;

    // Lexical path resolution cannot prove a mutation remains in the named
    // project because any cwd/operand component may be a symlink. Likewise a
    // shell redirection is an independent filesystem mutation. These commands
    // remain available through the ordinary explicit host prompt, but never
    // receive exact-scope/allow-in-execute authority from this compatibility.
    const unconfinedFilesystemMutation = REMOTE_FILESYSTEM_MUTATION_EXECUTABLES.has(executable)
      || words.some(word => /^(?:>|>>|<|<>|>&|<&)$/.test(word));

    // Curl and Wget load user/project configuration and expose multiple
    // retargeting grammars (config files, redirects, proxy/resolve, multiple
    // URLs, file-backed bodies). No remote HTTP mutation receives exact-scope
    // or allow-in-execute authority; it remains available behind a generic
    // explicit host prompt.
    if (['curl', 'wget'].includes(executable)) {
      mutationTargets.push(...uniqueTargets([cwdTarget, UNRESOLVED_REMOTE_SCOPE]));
      continue;
    }

    // Docker and Podman read ambient contexts/configuration that can redirect
    // even a flag-free command to another daemon. Preserve parsed identities
    // for an informative prompt, but never claim an exact engine/project.
    if (['docker', 'podman'].includes(executable)) {
      const parsedTargets = containerMutationScopeTargets(words, effectiveCwd) ?? [];
      mutationTargets.push(...uniqueTargets([
        cwdTarget, ...parsedTargets, UNRESOLVED_REMOTE_SCOPE,
      ]));
      continue;
    }

    const containerTargets = containerMutationScopeTargets(words, effectiveCwd);
    if (containerTargets) {
      mutationTargets.push(...uniqueTargets([cwdTarget, ...containerTargets]));
      continue;
    }
    const serviceTargets = remoteServiceMutationScopeTargets(words, companionServiceTargets);
    if (serviceTargets) {
      mutationTargets.push(...uniqueTargets([cwdTarget, ...serviceTargets]));
      continue;
    }
    const boundedPackageCommand = isBoundedProjectPackageCommand(words);
    if (boundedPackageCommand !== undefined) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }
    // Only a closed local-project grammar may inherit authority from cwd.
    // Unknown clients can address a cluster, cloud account, database, queue,
    // or another host without exposing that destination as a filesystem path.
    if (!unconfinedFilesystemMutation
      && boundedPackageCommand !== true
      && !PROJECT_SCOPED_REMOTE_EXECUTABLES.has(executable)) {
      mutationTargets.push(UNRESOLVED_REMOTE_SCOPE);
      continue;
    }

    const explicitTargets: string[] = [];
    const sedFileOperands = sedInPlaceMutationFileOperands(words);
    const installFileOperands = installMutationFileOperands(words);
    const targetDirectoryOperands = fileMutationTargetDirectoryOperands(words);
    const targetWords = sedFileOperands
      ?? installFileOperands
      ?? [...words.slice(1), ...(targetDirectoryOperands ?? [])];
    if (sedFileOperands?.length === 0) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    if (installFileOperands?.length === 0) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    if (targetDirectoryOperands?.length === 0 && words.slice(1).some(word =>
      /^-[A-Za-z]*t$/.test(word) || word === '--target-directory'
    )) explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
    for (let wordIndex = 0; wordIndex < targetWords.length; wordIndex += 1) {
      const word = targetWords[wordIndex]!;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) continue;
      const previousWord = targetWords[wordIndex - 1];
      const isRedirectTarget = previousWord !== undefined
        && /^(?:>|>>|<|<>|>&|<&)$/.test(previousWord);
      const isFileScopeOperand = !!sedFileOperands
        || REMOTE_FILE_MUTATOR_EXECUTABLES.has(executable)
        || isRedirectTarget;
      // A wildcard, home expansion, bare traversal/root operand, or malformed
      // path cannot safely inherit the cwd project. In particular, `..`, `/`
      // and glob operands used to disappear from pathReferences and silently
      // fall back to the authorized project scope.
      if (isFileScopeOperand && (hasDynamicOrGlobTargetSyntax(word)
        || /^(?:\.{1,2}\/*|\/+)$/.test(word))) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      if (isFileScopeOperand && word.startsWith('-')) continue;
      // A file mutator operand is one shell word and must be validated as one
      // complete literal path. Extracting a valid-looking prefix from
      // `/srv/workspace/orion evil` silently authorizes a different sibling.
      if (isFileScopeOperand && !STATIC_REMOTE_FILE_OPERAND_PATTERN.test(word)) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      const references = isFileScopeOperand ? [word] : pathReferences(word);
      if (isFileScopeOperand && !sedFileOperands && references.length === 0
        && (word.startsWith('/') || word.startsWith('./') || word.startsWith('../'))) {
        explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
        continue;
      }
      for (const reference of references) {
        const resolved = normalizeStaticRemotePath(reference, effectiveCwd);
        if (!resolved) {
          explicitTargets.push(UNRESOLVED_REMOTE_SCOPE);
          continue;
        }
        const target = remoteScopeFromPath(resolved);
        explicitTargets.push(target ?? UNRESOLVED_REMOTE_SCOPE);
      }
    }
    if (explicitTargets.length > 0) {
      mutationTargets.push(...uniqueTargets([
        ...explicitTargets,
        unconfinedFilesystemMutation ? UNRESOLVED_REMOTE_SCOPE : undefined,
      ]));
      continue;
    }
    if (cwdTarget) mutationTargets.push(...uniqueTargets([
      cwdTarget,
      unconfinedFilesystemMutation ? UNRESOLVED_REMOTE_SCOPE : undefined,
    ]));
  }

  const scoped = uniqueTargets(mutationTargets);
  if (scoped.length > 0) return bindRemoteEndpoint(scoped);
  if (sawMutationCommand) return [UNRESOLVED_REMOTE_SCOPE];
  const cwdTarget = effectiveCwd ? remoteScopeFromPath(effectiveCwd) : undefined;
  return cwdTarget
    ? bindRemoteEndpoint([cwdTarget])
    : command ? [UNRESOLVED_REMOTE_SCOPE] : extractInputTargets(input);
}

/** Resolve a transfer destination before deriving its concrete project. */
export function extractRemoteTransferScopeTargets(input: Record<string, unknown>): string[] {
  const endpoint = stringInput(input, ['server', 'host', 'hostname']);
  const literalEndpoint = endpoint && endpoint.length <= 256
    && /^[A-Za-z0-9._@:-]+$/.test(endpoint) ? endpoint : undefined;
  const cwd = rawRemotePathInput(input, ['cwd', 'workingDirectory', 'working_directory']);
  const remotePath = rawRemotePathInput(input, [
    'remotePath', 'remote_path', 'destination', 'targetPath', 'target_path',
  ]);
  const normalizedCwd = cwd ? normalizeStaticRemotePath(cwd) : undefined;
  const resolvedPath = remotePath
    ? normalizeStaticRemotePath(remotePath, normalizedCwd)
    : undefined;
  const lexicalScope = resolvedPath ? remoteScopeFromPath(resolvedPath) : undefined;
  // Upload/copy/write destinations can traverse symlinks and the transport
  // endpoint is an independent authority boundary. Without an atomic remote
  // confinement primitive, the lexical scope is display/prompt context only.
  return uniqueTargets([literalEndpoint, lexicalScope, UNRESOLVED_REMOTE_SCOPE]);
}

export function isSensitiveRemoteTransferSource(input: Record<string, unknown>): boolean {
  const source = rawRemotePathInput(input, [
    'localPath', 'local_path', 'source', 'sourcePath', 'source_path',
  ]);
  if (!source) return false;
  const normalized = source.replace(/\\/gu, '/');
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|(?:auth|token)(?:\.[^/]*)?|[^/]*(?:api[_-]?key|credential|private[_-]?key|secret|password)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(normalized)
    || /(?:^|\/)(?:\.secrets?|\.ssh|\.aws|credentials?|secrets?|\.config\/gcloud)(?:\/|$)/iu.test(normalized)
    || /(?:^|\/)\.docker\/config\.json$/iu.test(normalized);
}

export function remoteTransferPermissionPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const source = safePermissionPromptValue(
    rawRemotePathInput(input, ['localPath', 'local_path', 'source', 'sourcePath', 'source_path']),
    '[unresolved source]',
  );
  const endpoint = safePermissionPromptValue(
    stringInput(input, ['server', 'host', 'hostname']), '[unresolved host]',
  );
  const destination = safePermissionPromptValue(
    rawRemotePathInput(input, ['remotePath', 'remote_path', 'destination', 'targetPath', 'target_path']),
    '[unresolved destination]',
  );
  return `${toolName} source=${JSON.stringify(source)} destination=${JSON.stringify(`${endpoint}:${destination}`)}`;
}
