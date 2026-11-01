import { type PermissionsContext } from "../../permissions-config.ts";
import { classifySensitiveExternalAction, externalActionAuthorityPolicySegments, signedOssAtomicWriteAuthorizedSessionId } from "../sensitive-external-action.ts";
import { classifyBoundedTargetedRemoteOperationalInspection, isRemoteStaticSourceInspectionCandidate } from "../registered-observation.ts";
import { commandFromInput } from "./browser-channel.ts";
import type { PreToolUseCheckResult, PreToolUseInput, ToolEffectDescriptor } from "./contracts.ts";
import { BOUNDED_OSS_ATOMIC_WRITE_TOOL } from "./portable-scope.ts";
import { isBoundedStructuredRemoteTechnicalRead } from "./remote-observation.ts";
import { hasTargetBoundOperationalTechnicalReadAuthority } from "./remote-read-authority.ts";
import { isBoundedStructuredRemoteTechnicalUpload } from "./remote-upload.ts";
import { boundedResumedSharePointCreationContract, isBoundedResumedSharePointCreation } from "./sharepoint-contract.ts";
import { isBoundedOrionWorktreeCommand } from "./signed-resume-targets.ts";
import { terminalReconciliationToolAllowed } from "./terminal-reconciliation.ts";
import { classifyToolEffect } from "./tool-effects.ts";
import { STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS } from "./tool-names.ts";

interface ToolAuthorityFacts {
  readonly shellCommand: ReturnType<typeof commandFromInput>;
  readonly boundedStructuredRemoteTechnicalUploadLocalPath: ReturnType<typeof isBoundedStructuredRemoteTechnicalUpload>;
  readonly boundedStructuredRemoteTechnicalUpload: boolean;
  readonly boundedResumedSharePointCreation: boolean;
  readonly rejectedTargetBoundStructuredRemoteTechnicalRead: boolean;
  readonly toolEffect: ToolEffectDescriptor;
  readonly sensitiveAction: ReturnType<typeof classifySensitiveExternalAction>;
  readonly boundedOrionWorktreeCommand: boolean;
}

export function classifyToolAuthority(
  snapshot: Pick<PreToolUseInput,
    | 'input'
    | 'toolName'
    | 'dataFolderPath'
    | 'authenticatedUserAuthorizationSegments'
    | 'objectiveTerminalReconciliationPolicy'
    | 'sessionId'
  >,
  ctx: PreToolUseInput,
  permissionsContext: PermissionsContext,
  policyAuthorizationSegments: ReturnType<typeof externalActionAuthorityPolicySegments>,
): ToolAuthorityFacts | Extract<PreToolUseCheckResult, { type: 'block' }> {
  const {
    input,
    toolName,
    dataFolderPath,
    authenticatedUserAuthorizationSegments,
    objectiveTerminalReconciliationPolicy,
    sessionId,
  } = snapshot;
  const shellCommand = commandFromInput(input);
  const classifiedToolEffect = classifyToolEffect(
    toolName,
    input,
    permissionsContext,
    ctx.declaredToolCapabilities,
  );
  const boundedStructuredRemoteTechnicalRead = ctx.declaredToolCapabilities?.destructive !== true
    && isBoundedStructuredRemoteTechnicalRead(
      toolName,
      input,
      dataFolderPath,
      policyAuthorizationSegments,
    );
  // An upload is intentionally an external mutation. A correct MCP
  // `destructiveHint` must strengthen its effect classification, not erase an
  // otherwise exact human authorization for this server/root pair. The
  // bounded grammar below still controls authority and every mutation,
  // application-protection, evidence and permission gate remains active.
  const boundedStructuredRemoteTechnicalUploadLocalPath = isBoundedStructuredRemoteTechnicalUpload(
    toolName,
    input,
    dataFolderPath,
    policyAuthorizationSegments,
    authenticatedUserAuthorizationSegments,
  );
  const boundedStructuredRemoteTechnicalUpload =
    boundedStructuredRemoteTechnicalUploadLocalPath !== undefined;
  const boundedResumedSharePointCreation = isBoundedResumedSharePointCreation(
    toolName,
    input,
    policyAuthorizationSegments,
  );
  const resumedSharePointCreationContract = toolName === 'mcp__plc-microsoft-365__graph_request'
    ? boundedResumedSharePointCreationContract(policyAuthorizationSegments)
    : undefined;
  if (resumedSharePointCreationContract
    && ['DELETE', 'PATCH', 'POST', 'PUT'].includes(String(input["method"]).toUpperCase())
    && !boundedResumedSharePointCreation) {
    return {
      type: 'block',
      reason: [
        'Closed SharePoint creation contract mismatch: this Graph mutation was not executed.',
        'Retry only one complete contract shape: an atomic site-bound generic-list POST containing every column, or the exact signed drive-bound folder POST with an empty folder object and conflictBehavior "fail".',
        'Supported column facets are boolean, choice, personOrGroup, text, dateTime, and number with their bounded Graph fields.',
        'Do not retry an empty/partial list, split column creation, another site/drive/folder, replacement conflict behavior, multiple column facets, or unknown fields. Reconcile by Graph GET before any retry.',
      ].join(' '),
    };
  }
  const structuredRemoteStaticSourceCandidate = toolName === 'mcp__rbw-servers__ssh_execute'
    && !!shellCommand
    && isRemoteStaticSourceInspectionCandidate(shellCommand);
  const structuredRemoteOperationalInspectionCandidate = toolName === 'mcp__rbw-servers__ssh_execute'
    && !!shellCommand
    && !!classifyBoundedTargetedRemoteOperationalInspection(shellCommand);
  const rejectedTargetBoundStructuredRemoteTechnicalRead =
    (structuredRemoteOperationalInspectionCandidate
      || (STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS.has(toolName)
          || structuredRemoteStaticSourceCandidate)
        && hasTargetBoundOperationalTechnicalReadAuthority(input, policyAuthorizationSegments))
    && !boundedStructuredRemoteTechnicalRead;
  // These two connector operations can only inherit read authority from the
  // closed host grammar above. A trusted/readOnly MCP annotation describes the
  // remote server's claim, not the destination path or the complete payload,
  // and therefore cannot downgrade an unbounded download/session invocation.
  const unboundedStructuredRemoteLifecycleEffect: ToolEffectDescriptor | undefined =
    STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS.has(toolName) && classifiedToolEffect.kind === 'read'
      ? toolName === 'mcp__rbw-servers__ssh_download'
        ? { kind: 'local-write', reversibility: 'unknown', openWorld: true, source: 'input-semantics' }
        : { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' }
      : undefined;
  const toolEffect: ToolEffectDescriptor = boundedStructuredRemoteTechnicalRead
    ? { kind: 'read', reversibility: 'not-applicable', idempotent: true, openWorld: true, source: 'input-semantics' }
    : unboundedStructuredRemoteLifecycleEffect ?? classifiedToolEffect;
  // Presence of this policy is the lock. Decide before source activation,
  // prerequisites, permission prompts or generic read allowances can create a
  // side effect or interruption. Only exact host capabilities proceed.
  if (objectiveTerminalReconciliationPolicy
    && !terminalReconciliationToolAllowed(
      objectiveTerminalReconciliationPolicy,
      toolName,
      input,
      toolEffect,
    )) {
    return {
      type: 'block',
      reason: 'Terminal reconciliation is host-locked to exact persisted read replays and exact reviewer coordination. This tool or input is outside that immutable allowlist; reuse admissible receipts and finish the structured outcome without another action, permission request, alternate channel, or broader read.',
    };
  }
  const classifiedSensitiveAction = classifySensitiveExternalAction(toolName, input);
  // A generic remote-command name such as ssh_execute is not itself evidence
  // of mutation. Preserve the host's stricter parsed-command proof when it has
  // established that this exact invocation is read-only.
  // A connector annotation cannot turn an intrinsically mutating write tool
  // into a read and thereby skip its signed path/session contract. Remote MCP
  // metadata is descriptive here; the host-owned tool identity is decisive.
  const sensitiveAction = classifiedSensitiveAction?.category === 'external_mutation'
    && toolEffect.kind === 'read'
    && toolName !== BOUNDED_OSS_ATOMIC_WRITE_TOOL
    && classifiedSensitiveAction.boundedRemoteReadSideEffect !== true
    ? null : classifiedSensitiveAction;
  const boundedOrionWorktreeCommand = sensitiveAction?.category === 'external_mutation'
    && isBoundedOrionWorktreeCommand(
      toolName,
      input,
      sensitiveAction.boundedRemoteImplementationLifecycle === true,
      policyAuthorizationSegments,
    );
  const signedOssAtomicWriteSessionId = classifiedSensitiveAction?.boundedOssAtomicWrite
    ? signedOssAtomicWriteAuthorizedSessionId(
      classifiedSensitiveAction,
      policyAuthorizationSegments,
    )
    : undefined;
  if (signedOssAtomicWriteSessionId !== undefined
    && signedOssAtomicWriteSessionId !== sessionId) {
    return {
      type: 'block',
      reason: 'Signed OSS write contract session mismatch: this exact capability belongs to another durable session and cannot be copied or replayed here.',
    };
  }
  return {
    shellCommand,
    boundedStructuredRemoteTechnicalUploadLocalPath,
    boundedStructuredRemoteTechnicalUpload,
    boundedResumedSharePointCreation,
    rejectedTargetBoundStructuredRemoteTechnicalRead,
    toolEffect,
    sensitiveAction,
    boundedOrionWorktreeCommand,
  };
}
