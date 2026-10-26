import { protectedClaudeQuery as query } from "../claude-process.ts";
import { getDefaultOptions } from "../options.ts";
import { ProviderDispatchRejectedError } from "../backend/types.ts";
import type { FileAttachment } from "../../utils/files.ts";
import type { LLMQueryRequest, LLMQueryResult } from "../llm-tool.ts";
import { consumeLlmQueryMessages } from "../claude-llm-query.ts";
import { debug } from "../../utils/debug.ts";
import { generateConversationSummary } from "../conversation-summary.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
import type { ClaudeAgent } from '../claude-agent.ts';
import { resolveClaudeThinkingOptions, resolveClaudeNestedQueryModel, resolveClaudeMiniCompletionRoute } from './shared.ts';

// ============================================================
  // Mini Completion (for title generation and other quick tasks)
  // ============================================================

  /**
   * Run a simple text completion using Claude SDK.
   * No tools, empty system prompt - just text in → text out.
   * Uses the same auth infrastructure as the main agent.
   */
export async function runMiniCompletion(transportOwner: ClaudeAgent, prompt: string): Promise<string | null> {
    await transportOwner["config"].beforeProviderExecution?.();
    if (transportOwner["config"].missionCapabilityLock) {
        throw new ProviderDispatchRejectedError('Auxiliary mini-model completion is disabled for a specialized Mission');
    }
    const { model, thinkingOptions } = resolveClaudeMiniCompletionRoute({
        activeModel: transportOwner["getModel"](),
        activeThinkingLevel: transportOwner["getThinkingLevel"](),
        providerType: transportOwner["config"].providerType,
    });
    const options = {
        ...getDefaultOptions({ ...transportOwner["config"].envOverrides, ANTHROPIC_DEFAULT_HAIKU_MODEL: transportOwner["getModel"]() }),
        model,
        maxTurns: 1,
        systemPrompt: 'Reply with ONLY the requested text. No explanation.', // Minimal - no Claude Code preset
        ...thinkingOptions,
    };
    let result = '';
    for await (const msg of query({ prompt, options })) {
        if (msg.type === 'assistant') {
            for (const block of msg.message.content) {
                if (block.type === 'text') {
                    result += block.text;
                }
            }
        }
    }
    return result.trim() || null;
}

/**
   * Recover from a branch-fork session whose parent cwd is no longer
   * reachable on this machine, or whose SDK fork spawn failed before
   * establishing a child session.
   *
   * `isPreSpawn` selects the user-facing status text only — the recovery
   * mechanics are identical for pre-spawn (cwd missing on disk before the
   * SDK runs) and post-failure (anything that broke the fork attempt
   * after spawn).
   */
export async function* recoverFromStaleBranchFork(transportOwner: ClaudeAgent, userMessage: string, attachments: FileAttachment[] | undefined, isPreSpawn: boolean): AsyncGenerator<AgentEvent> {
    debug('[ClaudeAgent] Recovering from stale branch fork', {
        isPreSpawn,
        sessionId: transportOwner["config"].session?.id,
        parent: transportOwner["branchFromSdkSessionId"],
        parentCwd: transportOwner["branchFromSdkCwd"],
    });
    transportOwner["sessionId"] = null;
    transportOwner["branchFromSdkSessionId"] = null;
    transportOwner["branchFromSdkCwd"] = null;
    transportOwner["branchFromSdkTurnId"] = null;
    transportOwner["pinnedPreferencesPrompt"] = null;
    transportOwner["pinnedIncludeCoAuthoredBy"] = null;
    transportOwner["pinnedProjectContext"] = null;
    transportOwner["preferencesDriftNotified"] = false;
    // Atomic on-disk persistence: clears all four fork fields at once. This
    // supersedes onSdkSessionIdCleared, which only persists sdkSessionId and
    // would leave the branchFromSdk* fields on disk to reload next launch.
    transportOwner["config"].onBranchForkInvalidated?.();
    let retryMessage = userMessage;
    const summary = await transportOwner["generateBranchFallbackContext"]();
    if (summary) {
        retryMessage = `<branch_context_summary>\nThis is a branched conversation. The SDK-level fork is unavailable on this machine; here is a summary of the parent conversation:\n\n${summary}\n</branch_context_summary>\n\n${userMessage}`;
    }
    else {
        const recoveryContext = transportOwner["buildRecoveryContext"]();
        if (recoveryContext)
            retryMessage = recoveryContext + userMessage;
    }
    const statusMessage = isPreSpawn
        ? 'Branch source unavailable on this machine, restoring context from history...'
        : 'Branch fork failed, restoring context from history...';
    yield { type: 'info', message: statusMessage };
    yield* transportOwner["chat"](retryMessage, attachments, { isRetry: true });
}

/**
   * Generate fallback context from parent messages using the selected model.
   * Called when SDK-level branch fork fails and we need to inject parent context
   * into the retry without overflowing the context window with raw messages.
   */
export async function generateBranchFallbackContext(transportOwner: ClaudeAgent): Promise<string | null> {
    const messages = transportOwner["config"].getBranchFallbackMessages?.();
    if (!messages || messages.length === 0)
        return null;
    try {
        return await generateConversationSummary(messages, async (prompt) => (await transportOwner["queryLlm"]({ prompt })).text);
    }
    catch (error) {
        debug(`[ClaudeAgent] Branch fallback mini summary failed: ${error}`);
        return null;
    }
}

// ============================================================
  // queryLlm — Agent-native LLM query for call_llm tool (OAuth path)
  // ============================================================
export async function queryLlm(transportOwner: ClaudeAgent, request: LLMQueryRequest): Promise<LLMQueryResult> {
    await transportOwner["config"].beforeProviderExecution?.();
    const model = resolveClaudeNestedQueryModel({
        activeModel: transportOwner["getModel"](),
        requestedModel: request.model,
    });
    const options = {
        ...getDefaultOptions({ ...transportOwner["config"].envOverrides, ANTHROPIC_DEFAULT_HAIKU_MODEL: transportOwner["getModel"]() }),
        model,
        ...resolveClaudeThinkingOptions({
            thinkingLevel: transportOwner["_thinkingLevel"],
            model,
            providerType: transportOwner["config"].providerType,
            minimizeThinking: false,
        }),
        // Reasoning-model outputs (Opus extended thinking) can span multiple SDK-counted
        // turns even with no tools exposed. Tool surface here is empty, so no tool-use loop risk.
        maxTurns: 10,
        systemPrompt: request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.',
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.outputSchema ? {
            outputFormat: { type: 'json_schema' as const, schema: request.outputSchema },
        } : {}),
    };
    return consumeLlmQueryMessages(query({ prompt: request.prompt, options }), (msg) => transportOwner["debug"](msg));
}

// getActiveSourceSlugs() is now inherited from BaseAgent

  // ============================================================
  // Branch preflight
  // ============================================================

  /**
   * Branch preflight is intentionally a no-op for Claude sessions.
   *
   * The SDK's fork mechanism (resume + forkSession) runs naturally on the
   * first user message in chat(). Attempting to pre-fork with a separate
   * SDK subprocess is unreliable — the forked session gets garbage-collected
   * by Anthropic before the user sends their first message, or the subprocess
   * crashes during initialization.
   *
   * Defense-in-depth recovery in chat() handles fork failures:
   * - wasResuming covers branchFromSdkSessionId
   * - Session-expired detection checks errorMsg, rawErrorMsg, and stderr
   * - branchFromSdkSessionId is cleared on recovery to prevent retry loops
   */
export async function ensureBranchReady(transportOwner: ClaudeAgent): Promise<void> {
    // No preflight needed — fork happens on first chat() call via
    // resume: branchFromSdkSessionId + forkSession: true
}
