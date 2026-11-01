import { findSshHostIndex, makeAction, redactCommandPreview } from './action-presentation.ts';
import { uniqueTargets } from './action-targets.ts';
import { IN_SCOPE_IMPLEMENTATION_ALIASES, REMOTE_SERVICE_LIFECYCLE_AUTHORIZATION_TERMS, genericMutationAuthorizationTerms } from './action-vocabulary.ts';
import { UNRESOLVED_EXTERNAL_TARGET, UNRESOLVED_REMOTE_SCOPE } from './host-authorization.ts';
import { extractLiteralBusinessTargets } from './http-audience-payload.ts';
import { extractHttpExternalSendTargets, isLoopbackHost, mergeSensitiveShellActions } from './http-send-targets.ts';
import { packageManagerExternalOperation } from './remote-mutation-targets.ts';
import { commandFromActionInput, stringInput } from './remote-paths.ts';
import { extractRemoteCommandScopeTargets } from './remote-scope-targets.ts';
import { classifyDeployment, classifyHttpMutation, classifyPaymentCli, classifyRestart, classifySecretWrite, getGitPush, httpMutationCategory, isRemoteInlineSecretWrite } from './shell-effects.ts';
import { parseSimpleCommands, unwrapCommand } from './shell-parser.ts';
import { basename } from './target-syntax.ts';
import type { SensitiveExternalAction } from './types.ts';

export function classifyBash(
  input: Record<string, unknown>,
  initialTargets: string[] = [],
  promptType: SensitiveExternalAction['promptType'] = 'bash',
  allowImplementationAliases = false,
): SensitiveExternalAction | null {
  const command = commandFromActionInput(input);
  if (!command) return null;

  const inspectWords = (rawWords: string[], inheritedTargets: string[] = []): SensitiveExternalAction[] => {
    const words = unwrapCommand(rawWords);
    if (words.length === 0) return [];
    const executable = basename(words[0]!);

    if (['ash', 'bash', 'dash', 'ksh', 'sh', 'zsh'].includes(executable)) {
      const commandFlagIndex = words.findIndex(word => word === '-c' || word === '-lc');
      const nested = commandFlagIndex >= 0 ? words[commandFlagIndex + 1] : undefined;
      return nested
        ? parseSimpleCommands(nested).flatMap(nestedWords => inspectWords(nestedWords, inheritedTargets))
        : [];
    }

    if (executable === 'eval') {
      const nested = words.slice(1).join(' ');
      if (!nested || /[$`]/.test(nested)) {
        return [makeAction(
          'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
          [['explicit eval execution']],
        )];
      }
      const nestedCommands = parseSimpleCommands(nested);
      if (nestedCommands.length === 0) {
        return [makeAction(
          'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
          [['explicit eval execution']],
        )];
      }
      return nestedCommands.flatMap(nestedWords => inspectWords(nestedWords, inheritedTargets));
    }

    if (executable === 'ssh') {
      const hostIndex = findSshHostIndex(words);
      const host = hostIndex >= 0 ? words[hostIndex] : undefined;
      const remoteCommand = hostIndex >= 0 ? words.slice(hostIndex + 1).join(' ') : '';
      if (remoteCommand) {
        const scopedTargets = extractRemoteCommandScopeTargets({ server: host, command: remoteCommand });
        const remoteTargets = uniqueTargets([
          ...inheritedTargets,
          host,
          ...(scopedTargets.length > 0 ? scopedTargets : [host]),
        ]);
        const nestedActions: SensitiveExternalAction[] = [];
        if (isRemoteInlineSecretWrite(remoteCommand)) {
          nestedActions.push(makeAction(
            'secret_transfer',
            promptType,
            redactCommandPreview(command, 'secret_transfer'),
            remoteTargets,
          ));
        }
        for (const nestedWords of parseSimpleCommands(remoteCommand)) {
          nestedActions.push(...inspectWords(nestedWords, remoteTargets));
        }
        return nestedActions;
      }
      return [];
    }

    if (executable === 'git' && words.some((word, index) =>
      (word === '-c' && /^alias\./i.test(words[index + 1] ?? ''))
      || /^--config=alias\./i.test(word)
    )) {
      return [makeAction(
        'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'), [],
        [['explicit git alias execution']],
      )];
    }

    const opaquePackageOperation = packageManagerExternalOperation(words);
    if (opaquePackageOperation) {
      return [makeAction(
        opaquePackageOperation,
        promptType,
        redactCommandPreview(command, opaquePackageOperation),
        uniqueTargets([...inheritedTargets, UNRESOLVED_EXTERNAL_TARGET]),
        opaquePackageOperation === 'external_mutation'
          ? [['execute external package command']]
          : undefined,
      )];
    }

    const gitPush = getGitPush(words);
    if (gitPush) {
      return [makeAction('git_push', promptType, redactCommandPreview(command, 'git_push'), uniqueTargets([...inheritedTargets, ...gitPush.targets]))];
    }

    const deployment = classifyDeployment(words);
    if (deployment) {
      return [makeAction('deployment', promptType, redactCommandPreview(command, 'deployment'), uniqueTargets([...inheritedTargets, ...deployment.targets]))];
    }

    const restart = classifyRestart(words);
    if (restart) {
      return [makeAction(
        'service_restart',
        promptType,
        redactCommandPreview(command, 'service_restart'),
        uniqueTargets([...inheritedTargets, ...restart.targets]),
        promptType === 'mcp_mutation' && allowImplementationAliases
          ? REMOTE_SERVICE_LIFECYCLE_AUTHORIZATION_TERMS
          : undefined,
      )];
    }

    const secretTargets = classifySecretWrite(words, command);
    if (secretTargets) {
      return [makeAction('secret_transfer', promptType, redactCommandPreview(command, 'secret_transfer'), uniqueTargets([...inheritedTargets, ...secretTargets]))];
    }

    const paymentTargets = classifyPaymentCli(words);
    if (paymentTargets) {
      return [makeAction('payment', promptType, redactCommandPreview(command, 'payment'),
        uniqueTargets([...inheritedTargets, ...paymentTargets]))];
    }

    const http = classifyHttpMutation(words);
    if (http) {
      const category = httpMutationCategory(http);
      const externalSendTargets = category === 'external_send'
        ? extractHttpExternalSendTargets(words, command)
        : undefined;
      const businessTargets = externalSendTargets?.audienceTargets
        ?? extractLiteralBusinessTargets(command);
      const loopback = inheritedTargets.length > 0 && isLoopbackHost(http.host);
      const boundedLoopbackImplementation = loopback && allowImplementationAliases
        && !!stringInput(input, ['cwd', 'workingDirectory', 'working_directory'])
        && !inheritedTargets.includes(UNRESOLVED_REMOTE_SCOPE);
      const targets = uniqueTargets([
        ...inheritedTargets,
        ...(loopback ? [] : http.targets),
        ...businessTargets,
      ]);
      return [makeAction(
        category,
        promptType,
        redactCommandPreview(command, category),
        targets,
        category === 'external_mutation'
          ? [uniqueTargets([
            ...genericMutationAuthorizationTerms(http.method.toLowerCase())[0]!,
            ...(boundedLoopbackImplementation ? IN_SCOPE_IMPLEMENTATION_ALIASES : []),
          ])]
          : undefined,
        externalSendTargets?.conditionalTargets,
      )];
    }

    // Local destructive commands remain governed by the permission mode and
    // shell guard. This classifier adds the stricter action+target boundary
    // only when the same command mutates an already identified remote scope.
    if (inheritedTargets.length > 0 && ['rm', 'rmdir', 'unlink', 'shred'].includes(executable)) {
      return [makeAction(
        'external_mutation',
        promptType,
        redactCommandPreview(command, 'external_mutation'),
        inheritedTargets,
        genericMutationAuthorizationTerms('delete'),
      )];
    }

    return [];
  };

  const actions: SensitiveExternalAction[] = [];
  if (promptType === 'mcp_mutation' && isRemoteInlineSecretWrite(command)) {
    actions.push(makeAction(
      'secret_transfer', promptType, redactCommandPreview(command, 'secret_transfer'), initialTargets,
    ));
  }
  const parsedCommands = parseSimpleCommands(command);
  if (parsedCommands.length === 0 && (promptType === 'mcp_mutation'
    || /(?:^|[\s;&|()])(?:curl|wget|http|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|git|gh|kubectl|helm|terraform|ansible|systemctl|service|docker|podman|deploy|publish|send|mail)(?:$|[\s;&|()])/i.test(command))) {
    actions.push(makeAction(
      'external_mutation', promptType, redactCommandPreview(command, 'external_mutation'),
      uniqueTargets([...initialTargets, UNRESOLVED_EXTERNAL_TARGET]),
      [['unparsed potentially sensitive shell command']],
    ));
  }
  for (const words of parsedCommands) {
    actions.push(...inspectWords(words, initialTargets));
  }
  return mergeSensitiveShellActions(actions, command, promptType);
}
