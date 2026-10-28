import { FEATURE_FLAGS } from "../../../feature-flags.ts";
import { rewriteBashWithRtk } from "../rtk-rewrite.ts";
import { getConfigCliRedirect, getConfigDomainBashRedirect } from "./cli-redirect.ts";
import { validateConfigWrite } from "./config-validation.ts";
import type { PreToolUseCheckResult, PreToolUseInput, ToolEffectDescriptor } from "./contracts.ts";
import { expandToolPaths, qualifySkillName, stripToolMetadata } from "./input-transforms.ts";
import { terminalReconciliationToolAllowed } from "./terminal-reconciliation.ts";

export function prepareToolInput(
  snapshot: Pick<PreToolUseInput,
  | 'input'
  | 'toolName'
  | 'onDebug'
  | 'workspaceRootPath'
  | 'workingDirectory'
  | 'workspaceId'
  | 'objectiveTerminalReconciliationPolicy'
>,
  ctx: PreToolUseInput,
  toolEffect: ToolEffectDescriptor,
  boundedStructuredRemoteTechnicalUploadLocalPath: string | undefined,
): Extract<PreToolUseCheckResult, { type: 'allow' | 'modify' | 'block' }> {
  const { input, toolName, onDebug, workspaceRootPath, workingDirectory, workspaceId, objectiveTerminalReconciliationPolicy } = snapshot;

  // ============================================================
  // 6. INPUT TRANSFORMS
  // ============================================================
  let currentInput = input;
  let wasModified = false;

  // 5a. Path expansion
  const pathResult = expandToolPaths(toolName, currentInput, onDebug);
  if (pathResult.modified) {
    currentInput = pathResult.input;
    wasModified = true;
  }

  // Portable session tokens are model-facing only. Once the exact bounded
  // upload has passed every authority and local realpath check above, hand the
  // connector the canonical absolute source path rather than a literal token.
  if (boundedStructuredRemoteTechnicalUploadLocalPath !== undefined
    && currentInput["localPath"] !== boundedStructuredRemoteTechnicalUploadLocalPath) {
    currentInput = {
      ...currentInput,
      localPath: boundedStructuredRemoteTechnicalUploadLocalPath,
    };
    wasModified = true;
  }

  // 5b. Config-domain Bash guard (block direct labels/automations path operations unless using craft-agent)
  if (FEATURE_FLAGS.craftAgentsCli && toolName === 'Bash') {
    const configDomainBashRedirect = getConfigDomainBashRedirect(currentInput, workspaceRootPath, workingDirectory);
    if (configDomainBashRedirect) {
      return { type: 'block', reason: configDomainBashRedirect.message };
    }
  }

  // 5c. Config file validation
  const configResult = validateConfigWrite(toolName, currentInput, workspaceRootPath, onDebug);
  if (!configResult.valid) {
    return { type: 'block', reason: configResult.error! };
  }

  // 5d. Config file CLI redirect (labels + automations)
  if (FEATURE_FLAGS.craftAgentsCli) {
    const cliRedirect = getConfigCliRedirect(toolName, currentInput, workspaceRootPath, workingDirectory);
    if (cliRedirect) {
      return { type: 'block', reason: cliRedirect.message };
    }
  }

  // 5e. Skill qualification
  if (toolName === 'Skill') {
    const skillResult = qualifySkillName(
      currentInput,
      workspaceId,
      workspaceRootPath,
      workingDirectory,
      onDebug
    );
    if (skillResult.modified) {
      currentInput = skillResult.input;
      wasModified = true;
    }
  }

  // 5f. Metadata stripping
  const metadataResult = stripToolMetadata(toolName, currentInput, onDebug);
  if (metadataResult.modified) {
    currentInput = metadataResult.input;
    wasModified = true;
  }

  // 5g. RTK Bash rewrite (last input transform — flows into both 'modify' and 'prompt' results).
  // Permission decisions above and the ask-mode prompt below operate on the
  // ORIGINAL `input` parameter, so the LLM still believes it ran the original
  // command and our permission system gates the original command — only the
  // SDK's actual execution sees the rewritten form.
  if (!objectiveTerminalReconciliationPolicy && ctx.rtkContext?.enabled && ctx.rtkContext.path) {
    const rtkResult = rewriteBashWithRtk(
      toolName,
      currentInput,
      ctx.rtkContext.path,
      ctx.rtkContext.exclude,
      onDebug,
      { ...(ctx.dataFolderPath !== undefined ? { dataFolderPath: ctx.dataFolderPath } : {}), ...(workingDirectory !== undefined ? { workingDirectory } : {}) },
    );
    if (rtkResult.modified) {
      currentInput = rtkResult.input;
      wasModified = true;
    }
  }

  // The capability key applies to the executable input, not merely the model
  // payload. Built-in path/skill/RTK transforms may not move a terminal read
  // outside its exact persisted replay. Stripping the two inert UI metadata
  // fields remains admissible because canonicalization excludes only them.
  if (objectiveTerminalReconciliationPolicy
    && !terminalReconciliationToolAllowed(
      objectiveTerminalReconciliationPolicy,
      toolName,
      currentInput,
      toolEffect,
    )) {
    return {
      type: 'block',
      reason: 'Terminal reconciliation input normalization changed an operational field outside the exact host capability. The transformed invocation was not executed.',
    };
  }
  return wasModified ? { type: 'modify', input: currentInput } : { type: 'allow' };
}
