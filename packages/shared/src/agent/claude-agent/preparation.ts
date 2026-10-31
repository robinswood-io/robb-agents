import { protectedClaudeQuery as query } from "../claude-process.ts";
import { type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { getDefaultLlmConnection, getLlmConnection } from "../../config/storage.ts";
import { getValidClaudeOAuthToken } from "../../auth/state.ts";
import { getModelContextWindow } from "../../config/models.ts";
import { formatPreferencesForPrompt, getCoAuthorPreference } from "../../config/preferences.ts";
import type { FileAttachment } from "../../utils/files.ts";
import { expandPath } from "../../utils/paths.ts";
import { debug } from "../../utils/debug.ts";
import { getSessionScopedTools } from "../session-scoped-tools.ts";
import { assertExistingWorkingDirectory, isExistingDirectory } from "../spawn-helpers.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
import type { ClaudeAgent } from '../claude-agent.ts';
import { resolveClaudeThinkingOptions, createSourceProxyServers } from './shared.ts';
import type { SourceProxyGmailLifecycleContext, ClaudeQueryPreparation } from './shared.ts';

export async function* prepareClaudeQueryRuntime(transportOwner: ClaudeAgent, userMessage: string, attachments: FileAttachment[] | undefined, sessionId: string, _isRetry: boolean, gmailRuntimeId: string, gmailRuntimeContext: SourceProxyGmailLifecycleContext): AsyncGenerator<AgentEvent, ClaudeQueryPreparation | undefined, unknown> {
    if (transportOwner["config"].session?.workingDirectory) {
        await assertExistingWorkingDirectory(expandPath(transportOwner["config"].session.workingDirectory));
    }
    // For Claude OAuth connections: ensure token is fresh before turn starts
    if (transportOwner["config"].authType === 'oauth') {
        const slug = transportOwner["config"].connectionSlug || 'claude-max';
        const freshToken = await getValidClaudeOAuthToken(slug);
        if (freshToken.accessToken) {
            transportOwner["config"].envOverrides = {
                ...transportOwner["config"].envOverrides,
                CLAUDE_CODE_OAUTH_TOKEN: freshToken.accessToken,
            };
            process.env["CLAUDE_CODE_OAUTH_TOKEN"] = freshToken.accessToken;
        }
        else if (freshToken.migrationRequired) {
            yield {
                type: 'error',
                message: freshToken.migrationRequired.message,
            };
            yield { type: 'complete' };
            return;
        }
    }
    // Pin system prompt components on first chat() call for consistency after compaction
    // The SDK's resume mechanism expects system prompt consistency within a session
    const currentPreferencesPrompt = formatPreferencesForPrompt();
    const currentCoAuthorPref = getCoAuthorPreference();
    if (transportOwner["pinnedPreferencesPrompt"] === null) {
        // First chat in this session - pin current values
        transportOwner["pinnedPreferencesPrompt"] = currentPreferencesPrompt;
        transportOwner["pinnedIncludeCoAuthoredBy"] = currentCoAuthorPref;
        transportOwner["pinnedProjectContext"] = transportOwner.resolveProjectContext();
        debug('[chat] Pinned system prompt components for session consistency');
    }
    else {
        // Detect drift: warn user if context has changed since session started
        const preferencesDrifted = currentPreferencesPrompt !== transportOwner["pinnedPreferencesPrompt"];
        if (preferencesDrifted && !transportOwner.preferencesDriftNotified) {
            yield {
                type: 'info',
                message: `Note: Your preferences changed since this session started. Start a new session to apply changes.`,
            };
            transportOwner.preferencesDriftNotified = true;
            debug(`[chat] Detected drift in: preferences`);
        }
    }
    // Check if we have binary attachments that need the AsyncIterable interface
    const hasBinaryAttachments = attachments?.some(a => a.type === 'image' || a.type === 'pdf');
    transportOwner["lastTurnHadAttachments"] = !!hasBinaryAttachments;
    // Validate we have something to send
    if (!userMessage.trim() && (!attachments || attachments.length === 0)) {
        yield { type: 'error', message: 'Cannot send empty message' };
        yield { type: 'complete' };
        return;
    }
    // Pre-spawn detection: a stale `branchFromSdkCwd` carried across machines
    // (via "Send to Workspace") points at a directory that doesn't exist
    // locally. Feeding that into spawn() returns ENOENT, which the SDK
    // wraps as "Claude Code native binary not found at …" — sending users
    // hunting for a bundling bug. Catch it here and route through the same
    // branch fallback recovery the post-failure path uses.
    if (!_isRetry && transportOwner["branchFromSdkCwd"] && transportOwner["branchFromSdkSessionId"] &&
        !isExistingDirectory(transportOwner["branchFromSdkCwd"])) {
        yield* transportOwner.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ true);
        return;
    }
    // Get centralized mini agent configuration (from BaseAgent)
    // This ensures Claude and Codex agents use the same detection and constants
    const miniConfig = transportOwner["getMiniAgentConfig"]();
    // Block SDK tools that require UI we don't have:
    // - EnterPlanMode/ExitPlanMode: We use safe mode instead (user-controlled via UI)
    // - AskUserQuestion: Requires interactive UI to show question options to user
    // Note: Mini agents use a minimal tool list directly, so no additional blocking needed
    const disallowedTools: string[] = ['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'];
    // Build MCP servers config
    // Mini agents: only session tools (config_validate) to minimize token usage
    // Regular agents: full set including preferences, docs, and user sources
    // Build per-source proxy servers from centralized MCP pool (if available)
    const toolExecutionGuard = {
        begin: (toolName: string, args: Record<string, unknown>) => (transportOwner["beginAdmittedToolExecutionBySignature"]({
            toolName,
            toolInput: args,
            sessionId,
            runtimeId: gmailRuntimeId,
            authorizationEpoch: transportOwner.promptPreparationRevision,
        })),
        settle: (toolUseId: string) => transportOwner["settleAdmittedToolExecution"](toolUseId),
    };
    const sourceProxies = transportOwner["config"].mcpPool
        ? createSourceProxyServers(transportOwner["config"].mcpPool, gmailRuntimeContext, toolExecutionGuard)
        : {};
    const sourceProxyCount = Object.keys(sourceProxies).length;
    if (sourceProxyCount > 0) {
        debug('[chat] Source proxy servers created for', sourceProxyCount, 'sources');
    }
    // Build full MCP servers set first, then filter for mini agents
    const fullMcpServers: Options['mcpServers'] = {
        // Session-scoped tools (SubmitPlan, source_test, update_user_preferences, transform_data, etc.)
        session: getSessionScopedTools(sessionId, transportOwner["workspaceRootPath"], transportOwner["config"].workspace.id, toolExecutionGuard),
        // Craft Agents documentation - opt-in only for strict privacy/confidentiality
        ...(process.env["ROBB_ENABLE_CRAFT_DOCS_MCP"] === '1' && process.env["CRAFT_DISABLE_DOCS"] !== '1'
            ? {
                'craft-agents-docs': {
                    type: 'http' as const,
                    url: 'https://agents.craft.do/docs/mcp',
                },
            }
            : {}),
        // Per-source proxy servers from centralized MCP pool (MCP + API sources)
        // Each source gets its own SDK server keyed by slug (e.g., 'linear', 'github', 'gmail')
        // so the SDK produces correct tool names: mcp__{slug}__{toolName}
        ...sourceProxies,
    };
    // Mini agents: filter to minimal set using centralized keys
    // Regular agents: use full set including docs and user sources
    const mcpServers: Options['mcpServers'] = miniConfig.enabled
        ? transportOwner["filterMcpServersForMiniAgent"](fullMcpServers, miniConfig.mcpServerKeys)
        : fullMcpServers;
    // Configure SDK options
    // Model is always set by caller via connection config
    const model = transportOwner["_model"];
    // Log provider context for diagnostics (custom base URL = third-party provider)
    const defaultConnSlug = getDefaultLlmConnection();
    const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null;
    const activeBaseUrl = defaultConn?.baseUrl;
    if (activeBaseUrl) {
        debug(`[chat] Custom provider: baseUrl=${activeBaseUrl}, model=${model}, hasApiKey=${!!process.env["ANTHROPIC_API_KEY"]}`);
    }
    const thinkingOptions = resolveClaudeThinkingOptions({
        thinkingLevel: transportOwner["_thinkingLevel"],
        model,
        providerType: transportOwner["config"].providerType,
        minimizeThinking: miniConfig.minimizeThinking,
    });
    if ('effort' in thinkingOptions && thinkingOptions.effort) {
        debug(`[chat] Thinking: level=${transportOwner["_thinkingLevel"]}, effort=${thinkingOptions.effort}`);
    }
    else if ('maxThinkingTokens' in thinkingOptions) {
        debug(`[chat] Thinking: level=${transportOwner["_thinkingLevel"]}, tokens=${thinkingOptions.maxThinkingTokens}`);
    }
    else {
        debug(`[chat] Thinking: level=${transportOwner["_thinkingLevel"]}, disabled`);
    }
    // NOTE: Parent-child tracking for subagents is documented below (search for
    // "PARENT-CHILD TOOL TRACKING"). The SDK's parent_tool_use_id is authoritative.
    // Clear stderr buffer at start of each query
    transportOwner["lastStderrOutput"] = [];
    // Log mini agent mode details (using centralized config)
    if (miniConfig.enabled) {
        debug('[ClaudeAgent] 🤖 MINI AGENT mode - optimized for quick config edits');
        debug('[ClaudeAgent] Mini agent optimizations:', {
            model,
            tools: miniConfig.tools,
            mcpServers: miniConfig.mcpServerKeys,
            thinking: 'disabled',
            systemPrompt: 'lean (no Claude Code preset)',
        });
    }
    // Enable 1M context window for models that support it.
    // Despite Anthropic docs claiming 1M is GA, the API still defaults to 200k
    // without an explicit opt-in. The betas header only works for API key users;
    // for OAuth the [1m] model suffix is the way. Use the suffix unconditionally
    // since it works for both auth paths. See: anthropics/claude-agent-sdk-typescript#238
    // Gated by enable1MContext in global config (~/.craft-agent/config.json).
    // The interceptor also reads this to strip the SDK-injected beta header.
    const use1M = transportOwner["config"].enable1MContext !== false;
    const effectiveModel = use1M && getModelContextWindow(model) === 1000000
        ? `${model}[1m]`
        : model;
    // Capture the resolved spawn cwd here (rather than via an instance
    // field) so the catch handler reads the value passed to *this*
    // chatImpl invocation, not state left over from an earlier call.
    const resolvedCwd = transportOwner.resolveSpawnCwd({ isRetry: _isRetry, sessionId });
    await assertExistingWorkingDirectory(resolvedCwd);
    return { effectiveModel, thinkingOptions, miniConfig, resolvedCwd, mcpServers, disallowedTools };
}

export async function createClaudeTurnMessageSource(transportOwner: ClaudeAgent, userMessage: string, attachments: FileAttachment[] | undefined, options: Options, slashCommandRunsOutsidePersistentRuntime: boolean, _isRetry: boolean, gmailRuntimeContext: SourceProxyGmailLifecycleContext): Promise<AsyncIterable<SDKMessage>> {
    // Create AbortController for this query - allows force-stopping via forceAbort()
    transportOwner["currentQueryAbortController"] = new AbortController();
    const optionsWithAbort = {
        ...options,
        abortController: transportOwner["currentQueryAbortController"],
    };
    // Detect the local SDK command once, using the same exact parser as Pi.
    // It bypasses context wrapping and the provider-dispatch WAL because it
    // only asks the already-running local runtime to compact its own state.
    const trimmedMessage = userMessage.trim();
    const isSlashCommand = slashCommandRunsOutsidePersistentRuntime;
    // For SDK-fork branches: prepend a one-time context hint so the model treats
    // the parent conversation history (already in the SDK's messages via --fork-session)
    // as part of this conversation. Without this, the model sees new session metadata
    // and treats prior messages as "not this session."
    // branchFromSdkSessionId is non-null only on the first message (cleared after fork/recovery).
    let effectiveUserMessage = userMessage;
    if (!_isRetry && transportOwner["branchFromSdkSessionId"]) {
        const branchHint = `<branch_context>
This is a branched conversation. All prior messages in this conversation are part of your shared context with the user. When the user refers to "this conversation" or asks what you discussed, include the full conversation history — not just messages after the branch point.
</branch_context>`;
        effectiveUserMessage = `${branchHint}\n\n${userMessage}`;
        debug('[chat] Injected SDK-fork branch context hint into first message');
    }
    // Create the query - handle slash commands, binary attachments, or regular messages.
    //
    // WS2 keep-alive: for non-slash turns, ride ONE persistent streaming-input
    // query (created on the first turn, reused thereafter) so background
    // sub-agents survive across turns. chatImpl then drains a per-turn *channel*
    // (fed by the single consumer) instead of the raw query — ending that channel
    // at `result` finishes the turn without closing the subprocess. Slash commands
    // (e.g. /compact) always use the per-turn path (they mutate session state).
    let turnMessageSource: AsyncIterable<SDKMessage>;
    if (isSlashCommand) {
        // Send slash commands directly to SDK without context wrapping. This
        // is a local maintenance operation, not a provider-visible model turn.
        debug(`[chat] Detected SDK slash command: ${trimmedMessage}`);
        transportOwner["currentQuery"] = query({ prompt: trimmedMessage, options: optionsWithAbort });
        turnMessageSource = transportOwner["currentQuery"];
    }
    else {
        turnMessageSource = await transportOwner["performProviderDispatchWriteAhead"]<AsyncIterable<SDKMessage>>(() => transportOwner.createProviderTurnMessageSource(effectiveUserMessage, attachments, optionsWithAbort, gmailRuntimeContext));
    }
    return turnMessageSource;
}
