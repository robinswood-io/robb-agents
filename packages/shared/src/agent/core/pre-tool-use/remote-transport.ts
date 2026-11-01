import type { ToolEffectDescriptor } from "./contracts.ts";
import type { commandFromInput } from "./browser-channel.ts";
import type { classifySensitiveExternalAction } from "../sensitive-external-action.ts";
import { isProtectedApplicationPath, APPLICATION_PROTECTION_REASON } from "@craft-agent/session-tools-core";
import { resolve } from "node:path";
import { expandPath } from "../../../utils/paths.ts";
import { classifyReadOnlyRemoteObservationRepair, classifyNestedSshReadOnlyRemoteObservationRepair, containsLocalSshTransportInvocation } from "../registered-observation.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./contracts.ts";
import { readOnlyRemoteObservationRepairReason } from "./permission-context.ts";
import { FILE_WRITE_TOOLS, REMOTE_COMMAND_TOOL_PATTERN } from "./tool-names.ts";

interface RemoteTransportInput {
  readonly toolEffect: ToolEffectDescriptor;
  readonly isProviderDrivenAutonomy: boolean;
  readonly rejectedTargetBoundStructuredRemoteTechnicalRead: boolean;
  readonly sensitiveAction: ReturnType<typeof classifySensitiveExternalAction>;
  readonly shellCommand: ReturnType<typeof commandFromInput>;
  readonly sensitiveActionAuthorizedByObjective: boolean;
}

export function checkRemoteTransportAdmission(
  snapshot: Pick<PreToolUseInput,
    | 'toolName'
    | 'input'
    | 'workingDirectory'
    | 'workspaceRootPath'
  >,
  authority: RemoteTransportInput,
): {
  readonly remoteObservationRepair: ReturnType<typeof classifyReadOnlyRemoteObservationRepair>;
} | Extract<PreToolUseCheckResult, { type: 'block' }> {
  const {
    toolName,
    input,
    workingDirectory,
    workspaceRootPath,
  } = snapshot;
  const {
    toolEffect,
    isProviderDrivenAutonomy,
    rejectedTargetBoundStructuredRemoteTechnicalRead,
    sensitiveAction,
    shellCommand,
    sensitiveActionAuthorizedByObjective,
  } = authority;

  // Host invariant, before modes, whitelists, trusted-source hints or objective gates.
  // The kernel sandbox is the boundary for scripts/obfuscated commands; this gives
  // direct file tools a useful explanation and also covers host-side MCP handlers.
  if (toolEffect.kind !== 'read' || FILE_WRITE_TOOLS.has(toolName)) {
    const targets = [
      input["file_path"],
      input["path"],
      input["notebook_path"],
      input["destination"],
      input["outputFile"],
      input["localPath"],
    ];
    for (const target of targets) {
      if (typeof target === 'string' && isProtectedApplicationPath(resolve(workingDirectory ?? workspaceRootPath, expandPath(target)))) {
        return { type: 'block', reason: APPLICATION_PROTECTION_REASON };
      }
    }
  }

  // Once this exact server has inherited the objective's technical read
  // authority, the payload must satisfy the complete host-owned grammar. Do
  // not let broader mutation authority, Execute mode, or trusted/readOnly MCP
  // annotations turn a malformed path, destination, session shape, or hidden
  // field into an allowed call. An unrelated objective remains on the normal
  // effect/permission path rather than being captured by this exception.
  if (!isProviderDrivenAutonomy && rejectedTargetBoundStructuredRemoteTechnicalRead) {
    return {
      type: 'block',
      reason: 'Structured SSH read validation failed: this session, download, source read, loopback route/port, image, manifest, or compose target is not positively and exactly bound to the current human objective. Use only the documented fields and the explicitly named server/project; redirects, sibling projects, secret-like paths, local SSH, browser fallback, and broader destinations remain blocked.',
    };
  }

  // A fully redacted multi-category operation provides neither an inspectable
  // command nor a concrete target for informed consent. Never turn it into an
  // opaque prompt (or an Execute-policy auto-allow); require the agent to split
  // it into separately classifiable operations first.
  if (!isProviderDrivenAutonomy && sensitiveAction?.requiresInspectableSplit) {
    return {
      type: 'block',
      reason: 'Sensitive compound operation is not inspectable as one action. Split it into separate operations with a concrete target for each, then request authorization for each operation independently.',
    };
  }

  // Diagnose repairable read-only remote command shapes before permission
  // modes and objective gates return. This changes only the refusal reason;
  // the unsupported invocation remains blocked at every boundary.
  const observationRepairCandidate = shellCommand
    ? classifyReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const nestedSshObservationRepair = shellCommand
    ? classifyNestedSshReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const localSshTransport = !!shellCommand
    && /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
    && containsLocalSshTransportInvocation(shellCommand);
  const remoteObservationRepair = REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    ? observationRepairCandidate
    : /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
        && (nestedSshObservationRepair || observationRepairCandidate === 'git-hardening')
      ? nestedSshObservationRepair ?? observationRepairCandidate
      : undefined;
  if (!isProviderDrivenAutonomy && localSshTransport) {
    const repairGuidance = nestedSshObservationRepair
      ? `${readOnlyRemoteObservationRepairReason(nestedSshObservationRepair)} `
      : '';
    return {
      type: 'block',
      reason: `${repairGuidance}Local SSH transport through Bash/shell is disabled. Use the configured ssh_execute tool for the exact server and remote command. Do not bypass a structured SSH refusal through local Bash/ssh; keep the server, working directory, command, and audit trail in the registered ssh_execute transport.`,
    };
  }
  // A recoverable remote observation is, by definition, outside the closed
  // host read grammar. Block it before Execute mode or a broad workspace
  // allowlist can turn the diagnostic into an implicit grant. Commands that
  // already satisfy the read grammar never produce a repair classification.
  if (!isProviderDrivenAutonomy
    && REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    && remoteObservationRepair
    && toolEffect.kind !== 'read'
    && !(sensitiveAction?.boundedRemoteImplementationLifecycle === true
      && sensitiveActionAuthorizedByObjective)) {
    return {
      type: 'block',
      reason: readOnlyRemoteObservationRepairReason(remoteObservationRepair),
    };
  }
  return {
    remoteObservationRepair,
  };
}
