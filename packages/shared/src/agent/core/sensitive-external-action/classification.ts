import { makeAction, redactCommandPreview } from './action-presentation.ts';
import { IN_SCOPE_IMPLEMENTATION_ALIASES } from './action-vocabulary.ts';
import { BOUNDED_OSS_ATOMIC_WRITE_TOOL, classifyApi, classifyMcp, normalizedToolAction } from './connector-classification.ts';
import { ACTION_DETAILS, UNRESOLVED_REMOTE_SCOPE } from './host-authorization.ts';
import { commandFromActionInput } from './remote-paths.ts';
import { isBoundedRemoteImplementationLifecycleCommand } from './remote-project-lifecycle.ts';
import { boundedRemoteReadHasHiddenSideEffect } from './remote-read-effects.ts';
import { extractRemoteCommandScopeTargets, extractRemoteTransferScopeTargets, isSensitiveRemoteTransferSource, remoteTransferPermissionPreview } from './remote-scope-targets.ts';
import { classifyBash } from './shell-classification.ts';
import { BOUNDED_REMOTE_HOST_PROMPT_TOOLS, boundedOssAtomicWritePath, literalCanonicalAbsolutePosixPath } from './signed-oss-write.ts';
import type { SensitiveExternalAction } from './types.ts';

export function classifySensitiveExternalAction(
  toolName: string,
  input: Record<string, unknown>,
): SensitiveExternalAction | null {
  if (toolName === 'Bash') return classifyBash(input);
  if (/(?:^|__)(?:ssh_(?:execute|exec)(?:_sudo)?|remote_(?:execute|exec)|run_command)$/i.test(toolName)) {
    const boundedRemoteHostPrompt = BOUNDED_REMOTE_HOST_PROMPT_TOOLS.has(toolName);
    const targets = boundedRemoteHostPrompt
      ? extractRemoteCommandScopeTargets(input)
      : [UNRESOLVED_REMOTE_SCOPE];
    const action = classifyBash(input, targets, 'mcp_mutation', true)
      ?? classifyMcp(toolName, input, targets, true);
    const failClosedAction = action ?? (!boundedRemoteHostPrompt && commandFromActionInput(input)
      ? makeAction(
        'external_mutation',
        'mcp_mutation',
        redactCommandPreview(commandFromActionInput(input), 'external_mutation'),
        targets,
      )
      : null);
    if (!failClosedAction) return null;
    const remoteCommand = commandFromActionInput(input);
    const uniqueBoundedRemoteCommand = boundedRemoteHostPrompt
      && typeof input["command"] === 'string' && input["command"] === remoteCommand
      && !['cmd', 'script'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? remoteCommand : undefined;
    const boundedRemoteCommandAliasAmbiguity = boundedRemoteHostPrompt
      && ['cmd', 'script'].some(key => Object.prototype.hasOwnProperty.call(input, key));
    const literalBoundedEndpoint = boundedRemoteHostPrompt
      && typeof input["server"] === 'string'
      && input["server"] === input["server"].trim()
      && input["server"].length > 0 && input["server"].length <= 256
      && /^[A-Za-z0-9._@:-]+$/u.test(input["server"])
      && !['host', 'hostname'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? input["server"] : undefined;
    const literalBoundedCwd = boundedRemoteHostPrompt
      && typeof input["cwd"] === 'string'
      && literalCanonicalAbsolutePosixPath(input["cwd"])
      && !['workingDirectory', 'working_directory'].some(key => Object.prototype.hasOwnProperty.call(input, key))
      ? input["cwd"] : undefined;
    const connectorFallbackNeedsCommandPreview = failClosedAction.commandPreview === toolName;
    return {
      ...failClosedAction,
      // A connector-shaped fallback previously displayed only the MCP tool
      // name, making exact host confirmation impossible. Always surface the
      // bounded command itself while preserving category-aware redaction.
      ...(remoteCommand && connectorFallbackNeedsCommandPreview
        ? {
          commandPreview: redactCommandPreview(remoteCommand, failClosedAction.category),
        }
        : {}),
      description: `${failClosedAction.description} Tool: ${toolName}.`,
      remoteCommand: true,
      ...(boundedRemoteHostPrompt
        ? { boundedRemoteHostPrompt: true as const }
        : {}),
      ...(literalBoundedEndpoint ? { boundedRemoteEndpoint: literalBoundedEndpoint } : {}),
      ...(literalBoundedCwd ? { boundedRemoteWorkingDirectory: literalBoundedCwd } : {}),
      ...(boundedRemoteCommandAliasAmbiguity
        || uniqueBoundedRemoteCommand && boundedRemoteReadHasHiddenSideEffect(uniqueBoundedRemoteCommand)
        ? { boundedRemoteReadSideEffect: true as const }
        : {}),
      ...(literalBoundedEndpoint && literalBoundedCwd && uniqueBoundedRemoteCommand
        && isBoundedRemoteImplementationLifecycleCommand(uniqueBoundedRemoteCommand, literalBoundedCwd)
        ? { boundedRemoteImplementationLifecycle: true as const }
        : {}),
    };
  }
  if (toolName.startsWith('mcp__')) {
    if (toolName === BOUNDED_OSS_ATOMIC_WRITE_TOOL) {
      const classified = classifyMcp(toolName, input);
      const path = boundedOssAtomicWritePath(input);
      if (!classified || !path) return classified;
      return {
        ...classified,
        targetCandidates: [path],
        boundedOssAtomicWrite: true,
      };
    }
    const action = normalizedToolAction(toolName.split('__').slice(2).join('_'));
    const remoteTransfer = /(?:^|_)(?:ssh|remote)_(?:upload|copy|write|put)(?:_|$)/.test(action);
    const classified = classifyMcp(
      toolName,
      input,
      remoteTransfer ? extractRemoteTransferScopeTargets(input) : undefined,
      remoteTransfer,
    );
    if (!remoteTransfer || !classified) return classified;
    const category = isSensitiveRemoteTransferSource(input)
      ? 'secret_transfer' as const
      : classified.category;
    const boundedRemoteTransfer = toolName === 'mcp__rbw-servers__ssh_upload';
    return {
      ...classified,
      category,
      commandPreview: remoteTransferPermissionPreview(toolName, input),
      description: ACTION_DETAILS[category].description,
      authorizationTermGroups: category === 'external_mutation'
        ? [[...new Set([
          ...ACTION_DETAILS.external_mutation.authorizationTermGroups[0]!,
          ...IN_SCOPE_IMPLEMENTATION_ALIASES,
        ])]]
        : ACTION_DETAILS[category].authorizationTermGroups,
      ...(boundedRemoteTransfer ? { boundedRemoteHostPrompt: true as const } : {}),
    };
  }
  if (toolName.startsWith('api_')) return classifyApi(toolName, input);
  return null;
}
