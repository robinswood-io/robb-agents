import { abortSessionWithPendingApprovals } from "../tool-approval-abort.ts";
import { installStructuredToolErrors } from "../structured-tool-errors.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { defineTool, createAgentSession, getAgentDir, SessionManager as PiSessionManager, createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { requireExplicitPiModel } from "../model-resolution.ts";
import { activateEphemeralQueryModel } from "../query-model.ts";
import { resolveAgentCostControlPolicy, resolveEffectiveAgentContextLimits } from "../../../shared/src/config/agent-cost-control.ts";
import { loadWorkspaceConfig } from "../../../shared/src/workspaces/storage.ts";
import { getSessionPath } from "../../../shared/src/sessions/storage.ts";
import { THINKING_TO_PI } from "../../../shared/src/agent/backend/pi/constants.ts";
import { createWebFetchTool } from "../tools/web-fetch.ts";
import { resolveSearchProvider } from "../tools/search/resolve-provider.ts";
import { createSearchTool } from "../tools/search/create-search-tool.ts";
import { createSystemPromptController } from "../system-prompt-override.ts";
import { assertPiAuthProviderContractEnabled } from "../provider-contract-guard.ts";
import { installToolLoopFeedback } from "../tool-loop-feedback.ts";
import { INTRA_TURN_CONTEXT_CHECKPOINT_ERROR, estimateIntraTurnContextTokens, needsIntraTurnContextCheckpoint, pruneIntraTurnToolResults } from "../intra-turn-context-guard.ts";
import type { InboundMessage } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { startCallbackServer, stopCallbackServer } from "./callback-server.ts";
import { createAuthenticatedRegistry, isLocalhostUrl, resolvedCwd, setInterceptorApiHints, shouldPreferCustomEndpoint, syncStrictLocalEndpointNetworkGuard } from "./endpoints.ts";
import { debugLog, findMostRecentSessionFile, send } from "./stdio.ts";
import { buildProxyTools, wrapToolsWithHooks } from "./tool-execution.ts";

export async function ensureSession(runtimeState: PiRuntimeState): Promise<AgentSession> {
    if (!runtimeState.initConfig)
        throw new Error('Cannot create session: init not received');
    assertPiAuthProviderContractEnabled(runtimeState.initConfig.piAuth?.provider, process.env);
    if (runtimeState.piSession)
        return runtimeState.piSession;
    const cwd = resolvedCwd(runtimeState);
    const { modelRuntime, modelRegistry } = await createAuthenticatedRegistry(runtimeState);
    // Store at module scope for set_model handler
    runtimeState.piModelRegistry = modelRegistry;
    // Build tools: coding tools + web tools wrapped with permission hooks + proxy tools.
    // Search provider is selected based on the user's LLM connection:
    //   - OpenAI/OpenRouter → Responses API built-in web_search
    //   - ChatGPT Plus (openai-codex) → ChatGPT backend responses endpoint
    //   - Google → Gemini API with googleSearch grounding
    //   - Others → DuckDuckGo fallback
    //
    // IMPORTANT: resolve dynamically on each search call so token_update refreshes
    // are used without recreating the session.
    const searchProvider = {
        get name() {
            return resolveSearchProvider(runtimeState.initConfig?.piAuth, runtimeState.initConfig?.model).name;
        },
        async search(query: string, count: number) {
            return resolveSearchProvider(runtimeState.initConfig?.piAuth, runtimeState.initConfig?.model).search(query, count);
        },
    };
    const searchTool = createSearchTool(searchProvider);
    const webFetchTool = createWebFetchTool(() => runtimeState.initConfig ? getSessionPath(runtimeState.initConfig.workspaceRootPath, runtimeState.initConfig.sessionId) : null);
    // Strict local confidentiality: when connected to a local endpoint (Ollama, LM Studio, etc.),
    // do not expose external web_search (DuckDuckGo fallback) or web_fetch unless explicitly opted in.
    const isStrictLocalEndpoint = !!runtimeState.initConfig?.baseUrl
        && isLocalhostUrl(runtimeState.initConfig.baseUrl)
        && process.env["ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS"] !== '1';
    const webTools = isStrictLocalEndpoint ? [] : [searchTool, webFetchTool];
    // Pi SDK registration contract:
    //   - `customTools` accepts ToolDefinition[] — our hook-wrapped objects go here
    //   - `tools` is a string[] name allowlist — MUST include every tool we want active,
    //     otherwise Pi SDK defaults to the built-in [read, bash, edit, write] set and
    //     silently filters out everything else. Custom tool names with matching built-in
    //     names override the SDK's raw implementation inside _refreshToolRegistry, so
    //     our hooked versions take effect (permissions + large-response summarization).
    //   - Do NOT pass tool *objects* to `tools` — `allowedToolNames = new Set(options.tools)`
    //     then `.has(name)` returns false for every string lookup → zero tools active.
    const builtinDefs = [
        defineTool(createReadToolDefinition(cwd)),
        defineTool(createBashToolDefinition(cwd)),
        defineTool(createEditToolDefinition(cwd)),
        defineTool(createWriteToolDefinition(cwd)),
        defineTool(createGrepToolDefinition(cwd)),
        defineTool(createFindToolDefinition(cwd)),
        defineTool(createLsToolDefinition(cwd)),
    ];
    const proxyTools = buildProxyTools(runtimeState);
    const wrappedAll = wrapToolsWithHooks(runtimeState, [...builtinDefs, ...webTools, ...proxyTools]);
    const toolAllowlist = wrappedAll.map(t => t.name);
    debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyTools.length} proxy = ${wrappedAll.length} total`);
    // Build session options
    const sessionOptions: CreateAgentSessionOptions = {
        cwd,
        modelRuntime,
        customTools: wrappedAll,
        tools: toolAllowlist,
    };
    // Extension isolation: set agentDir to a temp directory under session path
    // to prevent loading global Pi extensions from ~/.pi/agent
    if (runtimeState.initConfig.sessionPath) {
        const agentDir = runtimeState.initConfig.agentDir || join(runtimeState.initConfig.sessionPath, '.pi-agent');
        mkdirSync(agentDir, { recursive: true });
        sessionOptions.agentDir = agentDir;
        // Session resume: use a per-Craft-session directory so the Pi SDK can
        // persist and resume its own session across subprocess restarts.
        // continueRecent() loads the existing session if one exists, otherwise
        // creates a new one — so this handles both first-run and resume.
        const sessionDir = join(runtimeState.initConfig.sessionPath, '.pi-sessions');
        mkdirSync(sessionDir, { recursive: true });
        if (runtimeState.initConfig.branchFromSessionPath) {
            // Branching: fork from the parent session's Pi session file.
            // Branches must not silently degrade to fresh sessions.
            const parentPiSessionDir = join(runtimeState.initConfig.branchFromSessionPath, '.pi-sessions');
            const parentPiSessionFile = findMostRecentSessionFile(parentPiSessionDir);
            if (!parentPiSessionFile) {
                throw new Error(`Pi branch preflight failed: no parent Pi session file found in ${parentPiSessionDir}`);
            }
            debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
            const forkedSessionManager = PiSessionManager.forkFrom(parentPiSessionFile, cwd, sessionDir);
            // Strict branch cutoff: move leaf to the selected parent entry if provided.
            // This is Pi's equivalent of Claude resumeSessionAt.
            if (runtimeState.initConfig.branchFromSdkTurnId) {
                const anchorId = runtimeState.initConfig.branchFromSdkTurnId;
                const anchorEntry = forkedSessionManager.getEntry(anchorId);
                if (!anchorEntry) {
                    throw new Error(`Pi branch preflight failed: branch anchor not found: ${anchorId}`);
                }
                forkedSessionManager.branch(anchorId);
                debugLog(`Applied Pi branch cutoff at entry: ${anchorId}`);
            }
            sessionOptions.sessionManager = forkedSessionManager;
        }
        else {
            sessionOptions.sessionManager = PiSessionManager.continueRecent(cwd, sessionDir);
        }
    }
    // Never let the SDK substitute its own provider/model default.
    if (!runtimeState.initConfig.model)
        throw new Error('A selected model is required to start the session');
    const selectedModel = requireExplicitPiModel(modelRegistry, runtimeState.initConfig.model, runtimeState.initConfig.piAuth?.provider, shouldPreferCustomEndpoint(runtimeState));
    sessionOptions.model = selectedModel;
    setInterceptorApiHints(selectedModel);
    // Set thinking level
    const piThinkingLevel = THINKING_TO_PI[runtimeState.initConfig.thinkingLevel as keyof typeof THINKING_TO_PI];
    if (piThinkingLevel) {
        sessionOptions.thinkingLevel = piThinkingLevel;
    }
    runtimeState.systemPromptController = await createSystemPromptController({
        cwd,
        agentDir: sessionOptions.agentDir ?? getAgentDir(),
        ...(sessionOptions.settingsManager !== undefined ? { settingsManager: sessionOptions.settingsManager } : {}),
    });
    sessionOptions.resourceLoader = runtimeState.systemPromptController.resourceLoader;
    // Create the session — tools flow through customTools + allowlist (see comment above).
    const { session } = await createAgentSession(sessionOptions);
    if (sessionOptions.model) {
        await activateEphemeralQueryModel(session, sessionOptions.model, runtimeState.initConfig.model);
    }
    if (piThinkingLevel)
        session.setThinkingLevel(piThinkingLevel);
    runtimeState.piSession = session;
    const previousTransformContext = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
        const transformed = previousTransformContext
            ? await previousTransformContext(messages, signal)
            : messages;
        const modelContextWindow = session.agent.state.model?.contextWindow;
        const policy = resolveAgentCostControlPolicy(loadWorkspaceConfig(runtimeState.initConfig!.workspaceRootPath)?.costControl);
        const compactAtTokens = policy.enabled
            ? resolveEffectiveAgentContextLimits(policy.context, modelContextWindow).compactAtTokens
            : Number.isFinite(modelContextWindow) && modelContextWindow! > 0
                ? Math.floor(modelContextWindow! * 0.75)
                : 0;
        if (needsIntraTurnContextCheckpoint(transformed, compactAtTokens)) {
            debugLog(`Intra-turn context checkpoint: estimated=${estimateIntraTurnContextTokens(transformed)} threshold=${compactAtTokens}`);
            if (process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] === '1') {
                throw new Error(INTRA_TURN_CONTEXT_CHECKPOINT_ERROR);
            }
            return pruneIntraTurnToolResults(transformed, compactAtTokens);
        }
        return transformed;
    };
    installToolLoopFeedback(session);
    installStructuredToolErrors(session);
    runtimeState.toolsChanged = false;
    debugLog(`Created Pi session: ${session.sessionId} (${wrappedAll.length} tools)`);
    // Notify main process of session ID
    send({ type: 'session_id_update', sessionId: session.sessionId });
    return session;
}

// ============================================================
// Command Handlers
// ============================================================
export async function handleInit(runtimeState: PiRuntimeState, msg: Extract<InboundMessage, {
    type: 'init';
}>): Promise<void> {
    // Clean up any existing session from a previous init
    if (runtimeState.piSession) {
        if (runtimeState.unsubscribeEvents) {
            runtimeState.unsubscribeEvents();
            runtimeState.unsubscribeEvents = null;
        }
        runtimeState.piSession.dispose();
        runtimeState.piSession = null;
        runtimeState.moduleAuthStorage = null; // Reset so createAuthenticatedRegistry() creates fresh storage
        debugLog('Cleaned up existing session for re-init');
    }
    runtimeState.initConfig = msg;
    syncStrictLocalEndpointNetworkGuard(runtimeState);
    // Azure OpenAI requires a tenant-specific endpoint URL.
    // The Pi SDK (via Vercel AI SDK) reads AZURE_OPENAI_BASE_URL from env.
    if (msg.piAuth?.provider === 'azure-openai-responses' && msg.baseUrl) {
        process.env["AZURE_OPENAI_BASE_URL"] = msg.baseUrl;
        debugLog(`Set AZURE_OPENAI_BASE_URL=${msg.baseUrl}`);
    }
    // Start callback server for call_llm (idempotent — skips if already running)
    await startCallbackServer(runtimeState);
    send({
        type: 'ready',
        sessionId: null,
        callbackPort: runtimeState.callbackPort,
    });
}

export async function handleAbort(runtimeState: PiRuntimeState): Promise<void> {
    runtimeState.incompleteToolTailRecovery.requestAbort();
    try {
        await abortSessionWithPendingApprovals(runtimeState.piSession, runtimeState.pendingPreToolUse);
    }
    catch (error) {
        debugLog('Abort failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

export function handleShutdown(runtimeState: PiRuntimeState): void {
    debugLog('Shutdown requested');
    // Unsubscribe events
    if (runtimeState.unsubscribeEvents) {
        runtimeState.unsubscribeEvents();
        runtimeState.unsubscribeEvents = null;
    }
    // Dispose session
    if (runtimeState.piSession) {
        runtimeState.piSession.dispose();
        runtimeState.piSession = null;
    }
    // Stop callback server
    stopCallbackServer(runtimeState);
    // Reject pending promises
    for (const [, pending] of runtimeState.pendingPreToolUse) {
        pending.resolve({ action: 'block', reason: 'Server shutting down' });
    }
    runtimeState.pendingPreToolUse.clear();
    for (const [, pending] of runtimeState.pendingToolExecutions) {
        pending.resolve({ content: 'Server shutting down', isError: true });
    }
    runtimeState.pendingToolExecutions.clear();
    process.exit(0);
}
