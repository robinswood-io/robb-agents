import { isReadOnlyBashCommandWithConfig } from "../../mode-manager.ts";
import { permissionsConfigCache, type PermissionsContext } from "../../permissions-config.ts";
import { isClearlyReadOnlyToolAction } from "../sensitive-external-action.ts";
import { classifyToolNameMutationSemantics } from "../tool-name-semantics.ts";
import { containsRemoteStaticSourceInspectionCandidate, isReadOnlyRegisteredShellObservation } from "../registered-observation.ts";
import { commandFromInput } from './browser-channel.ts';
import { isHostOwnedConnectorObservation } from './connector-observation.ts';
import type { DeclaredToolCapabilities, ToolEffectDescriptor } from './contracts.ts';
import { isBrowserKeyboardText } from './gmail-channel.ts';
import { BUILTIN_READ_TOOLS, FILE_WRITE_TOOLS, MUTATION_HTTP_METHOD_PATTERN, REMOTE_COMMAND_TOOL_PATTERN } from './tool-names.ts';

export function classifyToolEffect(
  toolName: string,
  input: Record<string, unknown>,
  permissionsContext?: PermissionsContext,
  declared?: DeclaredToolCapabilities,
): ToolEffectDescriptor {
  if (BUILTIN_READ_TOOLS.has(toolName)) {
    return { kind: 'read', reversibility: 'not-applicable', idempotent: true, source: 'builtin' };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'local-write', reversibility: 'unknown', source: 'builtin' };
  }

  const config = permissionsContext
    ? permissionsConfigCache.getMergedConfig(permissionsContext)
    : undefined;
  const isMcpTool = toolName.startsWith('mcp__');
  const nameSemantics = classifyToolNameMutationSemantics(toolName);

  // A destructive hint can only make the decision more restrictive, so it is
  // safe to honor even when it came from an untrusted remote MCP server.
  if (isMcpTool && declared?.destructive === true) {
    return {
      kind: 'external-mutation',
      reversibility: 'irreversible',
      idempotent: declared.idempotent,
      openWorld: declared.openWorld,
      source: 'mcp-annotations',
    };
  }

  if (isMcpTool && isHostOwnedConnectorObservation(toolName, input)) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: true,
      source: 'host-connector-contract',
    };
  }

  // Explicit keyboard delivery can affect a remote desktop; neither a legacy
  // browser read allowlist nor remote readOnly annotations can downgrade it.
  if (isBrowserKeyboardText(toolName, input)) {
    return { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' };
  }

  const command = commandFromInput(input);
  if ((toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName)) && command && config) {
    // The mutable user permission file is not the only source of truth for
    // operational reads. Keep a small host-owned grammar for exact GET/HEAD,
    // docker/systemd/GitHub inspections so an `ssh_execute` transport cannot
    // become a sensitive mutation merely because its leaf name says execute.
    const remoteCommandTransport = REMOTE_COMMAND_TOOL_PATTERN.test(toolName);
    // A workspace permission regex is user-extensible and has no access to
    // the objective/server binding. Never let such a broad `sed -n` rule turn
    // a remote source path into a generic read; runPreToolUseChecks applies
    // the narrower host-owned target/channel/path grant later.
    const remoteStaticSourceCandidate = remoteCommandTransport
      && containsRemoteStaticSourceInspectionCandidate(command);
    const readOnly = !remoteStaticSourceCandidate
      && isReadOnlyBashCommandWithConfig(command, config)
      || (remoteCommandTransport && isReadOnlyRegisteredShellObservation(command));
    if (readOnly) {
      return {
        kind: 'read',
        reversibility: 'not-applicable',
        idempotent: true,
        openWorld: remoteCommandTransport,
        source: 'input-semantics',
      };
    }
    return {
      kind: toolName === 'Bash' ? 'unknown' : 'external-mutation',
      reversibility: 'unknown',
      openWorld: remoteCommandTransport,
      source: 'input-semantics',
    };
  }

  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
  if (
    (method && MUTATION_HTTP_METHOD_PATTERN.test(method))
    || (action && classifyToolNameMutationSemantics(action) === 'mutation')
  ) {
    return {
      kind: isMcpTool || toolName.startsWith('api_') ? 'external-mutation' : 'unknown',
      reversibility: 'unknown',
      openWorld: isMcpTool || toolName.startsWith('api_'),
      source: 'input-semantics',
    };
  }

  // A connector preflight can contain the mutation it validates in its name
  // (`gmail_send_preflight`). Admit it as a read only when both the semantic
  // shape is explicitly non-executing and a host-owned permission pattern
  // authorizes that exact connector family. Neither condition alone is trust.
  if (
    isMcpTool
    && nameSemantics !== 'ambiguous-compound'
    && isClearlyReadOnlyToolAction(toolName)
    && config?.readOnlyMcpPatterns.some(pattern => pattern.test(toolName))
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: true,
      openWorld: declared?.openWorld,
      source: 'permissions-config',
    };
  }

  // Explicit host-parsed mutation tokens win over remote MCP annotations.
  // A server must not be able to label upload/write/delete as trusted read-only
  // and thereby bypass Explore mode or the target-bound mutation contract.
  if ((isMcpTool || toolName.startsWith('api_')) && nameSemantics === 'mutation') {
    return {
      kind: 'external-mutation',
      reversibility: 'unknown',
      idempotent: declared?.idempotent,
      openWorld: declared?.openWorld ?? true,
      source: 'input-semantics',
    };
  }

  if (
    isMcpTool
    && declared?.trusted === true
    && declared.readOnly === true
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: declared.idempotent,
      openWorld: declared.openWorld,
      source: 'mcp-annotations',
    };
  }

  if (toolName.startsWith('api_') || toolName.includes('__api_')) {
    const effectiveMethod = method ?? 'GET';
    return effectiveMethod === 'GET'
      ? { kind: 'read', reversibility: 'not-applicable', idempotent: true, openWorld: true, source: 'input-semantics' }
      : { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' };
  }

  // permissions.json is host-owned. Retain its explicitly supported MCP
  // reads, but only after explicit mutation semantics above have been ruled
  // out. Remote MCP annotations alone never reach this branch as authority.
  if (
    isMcpTool
    && nameSemantics === 'neutral'
    && config?.readOnlyMcpPatterns.some(pattern => pattern.test(toolName))
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: declared?.idempotent,
      openWorld: declared?.openWorld,
      source: 'permissions-config',
    };
  }

  return { kind: 'unknown', reversibility: 'unknown', source: 'unknown' };
}
