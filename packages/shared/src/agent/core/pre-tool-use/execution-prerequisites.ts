import { enforceTaskToolIsolation } from "../task-tool-isolation.ts";
import { oversizedRbwOssCatalogReadGuidance } from "./autonomy-request-guards.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./contracts.ts";
import type { ContextualGmailToolUseClaim } from "./gmail-state.ts";
import { expandToolPaths } from "./input-transforms.ts";
import { BUILT_IN_MCP_SERVERS } from "./tool-names.ts";

export function checkExecutionPrerequisites(
  snapshot: Pick<PreToolUseInput,
  | 'executionIsolation'
  | 'toolName'
  | 'input'
  | 'onDebug'
  | 'workspaceRootPath'
  | 'workingDirectory'
  | 'missionCapabilityLock'
  | 'activeSourceSlugs'
  | 'allSourceSlugs'
  | 'objectiveTerminalReconciliationPolicy'
  | 'hasSourceActivation'
  | 'prerequisiteManager'
  | 'preloadedSourceGuidePaths'
>,
  contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined,
): PreToolUseCheckResult | undefined {
  const { executionIsolation, toolName, input, onDebug, workspaceRootPath, workingDirectory, missionCapabilityLock, activeSourceSlugs, allSourceSlugs, objectiveTerminalReconciliationPolicy, hasSourceActivation, prerequisiteManager, preloadedSourceGuidePaths } = snapshot;

  // ============================================================
  // 2. TASK TOOL ISOLATION (persistent host-side boundary)
  // ============================================================
  if (executionIsolation) {
    const isolationInput = expandToolPaths(toolName, input, onDebug).input;
    const isolationDecision = enforceTaskToolIsolation({
      toolName,
      input: isolationInput,
      workspaceRootPath,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      isolation: executionIsolation,
      ...(missionCapabilityLock !== undefined ? { missionCapabilityLock } : {}),
    });
    if (!isolationDecision.allowed) {
      const reason = `Task execution isolation: ${isolationDecision.reason ?? 'blocked'}`;
      onDebug?.(`Task isolation: blocking ${toolName} — ${reason}`);
      return { type: 'block', reason };
    }
  }

  // ============================================================
  // 3. SOURCE BLOCKING (inactive MCP sources)
  // ============================================================
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1];
    if (parts.length >= 3 && serverName && !BUILT_IN_MCP_SERVERS.has(serverName)) {
      const isActive = activeSourceSlugs.includes(serverName);
      if (!isActive) {
        const sourceExists = allSourceSlugs.includes(serverName);
        if (objectiveTerminalReconciliationPolicy) {
          return {
            type: 'block',
            reason: `Terminal reconciliation cannot activate inactive source "${serverName}". Source activation is a configuration mutation outside the exact read-replay capability; reuse preserved evidence or finish with the truthful policy blocker.`,
          };
        }
        if (contextualGmailToolUseClaim) {
          contextualGmailToolUseClaim.phase = 'awaiting-source-reentry';
        }
        onDebug?.(`Source "${serverName}" not active (exists=${sourceExists}, hasActivation=${hasSourceActivation})`);
        return {
          type: 'source_activation_needed',
          sourceSlug: serverName,
          sourceExists,
        };
      }
    }
  }

  // ============================================================
  // 4. PREREQUISITE CHECK (guide.md before source tools)
  // ============================================================
  if (prerequisiteManager) {
    if (preloadedSourceGuidePaths?.length) {
      prerequisiteManager.markSourceGuidesLoadedInContext?.(preloadedSourceGuidePaths);
    }

    // Permit a bounded acquisition command; only its successful result earns credit.
    if (toolName === 'Bash' && prerequisiteManager.trackBashSkillRead(input)) {
      // Fall through without clearing the prerequisite before execution.
    } else {
      const prereqResult = prerequisiteManager.checkPrerequisites(toolName);
      if (!prereqResult.allowed) {
        return { type: 'block', reason: prereqResult.blockReason!, source: 'prerequisite' };
      }
    }
  }

  const oversizedCatalogGuidance = oversizedRbwOssCatalogReadGuidance(toolName, input);
  if (oversizedCatalogGuidance) {
    onDebug?.(`Bounded connector read: blocking whole OSS catalog read for ${String(input["path"])}`);
    return {
      type: 'block',
      reason: `The requested OSS file is a known oversized catalog and this connector read has no enforced offset or byte limit. ${oversizedCatalogGuidance}`,
    };
  }
  return undefined;
}
