import type { AgentEvent } from "@craft-agent/core/types";
import type { FileAttachment } from "../../utils/files.ts";
import { buildTransferredSessionContext } from "../conversation-summary.ts";
import type { ChatOptions } from "../backend/types.ts";
import type { BaseAgent } from '../base-agent.ts';

// ============================================================
  // Chat entry point (template method)
  // ============================================================

  /**
   * Send a message and stream back events.
   * Validates skill mentions, registers prerequisites, prepends read directive,
   * then delegates to chatImpl. All skill logic is handled here — chatImpl
   * never sees skill paths.
   */
export async function* chat(transportOwner: BaseAgent, message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const { skillPaths, sealedSkillContents, cleanMessage, missingSkills } = transportOwner["extractSkillPaths"](message);
    if (missingSkills.length > 0) {
        yield { type: 'error', message: `Skill(s) not found: ${missingSkills.join(', ')}` };
        yield { type: 'complete' };
        return;
    }
    // Register skill prerequisites — blocks all tools until SKILL.md files are read.
    if (skillPaths.size > 0) {
        transportOwner["prerequisiteManager"].registerSkillPrerequisites([...skillPaths.values()]);
    }
    // Prepend branch seed context (for seeded branch sessions) and transferred-session summary.
    const branchSeedContext = transportOwner["buildBranchSeedContext"](transportOwner["config"].getBranchSeedMessages?.());
    if (branchSeedContext) {
        transportOwner["config"].markBranchSeedApplied?.();
    }
    const transferredSessionSummary = transportOwner["config"].getTransferredSessionSummary?.();
    const transferredSessionContext = transferredSessionSummary
        ? buildTransferredSessionContext(transferredSessionSummary)
        : null;
    if (transferredSessionContext) {
        transportOwner["config"].markTransferredSessionSummaryApplied?.();
    }
    // Prepend read directive to the message so the model reads SKILL.md first.
    const directive = transportOwner["formatSkillDirective"](skillPaths);
    const sealedDirective = transportOwner["formatSealedSkillDirective"](sealedSkillContents);
    const messageParts = [branchSeedContext, transferredSessionContext, directive, sealedDirective, cleanMessage].filter(Boolean);
    const effectiveMessage = messageParts.join('\n\n');
    // Capture the raw user message for source-activation auto-retry. `cleanMessage`
    // has skill paths stripped but otherwise matches what the user typed — exactly
    // what we want to resend when an activation forces a turn restart.
    transportOwner["setCurrentTurnUserMessage"](cleanMessage);
    try {
        await transportOwner["config"].beforeProviderExecution?.();
        yield* transportOwner["chatImpl"](effectiveMessage, attachments, options);
    }
    finally {
        transportOwner["setCurrentTurnUserMessage"](null);
    }
}
