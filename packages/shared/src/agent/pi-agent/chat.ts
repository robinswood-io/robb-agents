import type { AgentEvent } from "@craft-agent/core/types";
import type { FileAttachment } from "../../utils/files.ts";
import { i18n } from "../../i18n/index.ts";
import type { ChatOptions } from "../backend/types.ts";
import { AbortReason, ProviderDispatchRejectedError } from "../backend/types.ts";
import { getBackendRuntime } from "../backend/internal/driver-types.ts";
import { SourceActivationDrainController } from "../source-activation-drain.ts";
// System prompt for Craft Agent context
import { getSystemPromptAsync } from "../../prompts/system.ts";
import { getCoAuthorPreference } from "../../config/preferences.ts";
import { ROBINSWOOD_BACKEND_NAME } from "../../robinswood-branding.ts";
// Credential manager for token storage
import { getCredentialManager } from "../../credentials/manager.ts";
// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import { mergeSessionScopedToolCallbacks } from "../session-scoped-tools.ts";
import { getPermissionModeDiagnostics } from "../mode-manager.ts";
// Session storage (plans folder path)
import { getSessionPlansPath } from "../../sessions/storage.ts";
import { InvalidWorkingDirectoryError } from "../spawn-helpers.ts";
import { parseCompactCommand } from "../compact-command.ts";
import type { PiAgent } from '../pi-agent.ts';
import { PiRuntimeInterruptedError, shouldRefreshPiOAuthBeforeSpawn } from './shared.ts';

// ============================================================
  // Chat (AsyncGenerator backed by the subprocess event queue)
  // ============================================================
export async function* chatImpl(transportOwner: PiAgent, agentClass: typeof PiAgent, messageParam: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    let providerHandoffTurnId: string | undefined;
    const preparationRevision = transportOwner["promptPreparationRevision"];
    transportOwner["revokeAdmittedToolExecutions"]();
    // Reset state for new turn
    transportOwner["_isProcessing"] = true;
    transportOwner["abortReason"] = undefined;
    transportOwner["eventQueue"].reset();
    transportOwner["currentUserMessage"] = message;
    transportOwner["adapter"].startTurn();
    // Fire UserPromptSubmit hook event (fire-and-forget)
    transportOwner["emitAutomationEvent"]('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: message,
    });
    // Refresh session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
    // IMPORTANT: merge (don't replace) so SessionManager-provided browserPaneFns
    // survives across turns.
    const sessionId = transportOwner["config"].session?.id;
    if (sessionId) {
        mergeSessionScopedToolCallbacks(sessionId, {
            onPlanSubmitted: (planPath) => transportOwner["onPlanSubmitted"]?.(planPath),
            onAuthRequest: (request) => transportOwner["onAuthRequest"]?.(request),
            queryFn: (request) => transportOwner["queryLlm"](request),
        });
    }
    try {
        const bridgeProvider = getBackendRuntime(transportOwner["config"]).piAuthProvider;
        const bridgeName = bridgeProvider === 'google-antigravity' ? 'Antigravity'
            : bridgeProvider === 'mistral-vibe' ? 'Mistral Vibe' : undefined;
        if (bridgeName && attachments?.some(attachment => attachment.type === 'image' || attachment.mimeType?.startsWith('image/'))) {
            // These external bridges send text only. Reject the turn before launch
            // so direct callers cannot silently discard images or transmit a partial prompt.
            yield {
                type: 'error',
                message: i18n.t('errors.bridgeImagesUnsupported', {
                    provider: bridgeName,
                    defaultValue: '{{provider}} cannot receive image attachments through this connection. Choose a connection that supports images, or remove the images before sending.',
                }),
            };
            yield { type: 'complete' };
            return;
        }
        // For OAuth providers with short-lived access tokens: proactively ensure tokens
        // are fresh before turn start so getPiAuth() or the running subprocess has valid credentials.
        const runtime = getBackendRuntime(transportOwner["config"]);
        if (transportOwner["config"].authType === 'oauth' && runtime.piAuthProvider) {
            const slug = transportOwner["config"].connectionSlug || 'pi';
            const expectedBindingId = transportOwner["config"].expectedLlmCredentialBindingId;
            const stored = await getCredentialManager().getLlmOAuth(slug, expectedBindingId);
            if (shouldRefreshPiOAuthBeforeSpawn({
                authType: transportOwner["config"].authType,
                piAuthProvider: runtime.piAuthProvider,
                refreshToken: stored?.refreshToken,
                expiresAt: stored?.expiresAt,
                refreshInFlight: agentClass["globalRefreshMutex"].has(`${slug}\u0000${expectedBindingId ?? 'unsealed'}`),
            })) {
                transportOwner["debug"](`${runtime.piAuthProvider} token expired or expiring soon — proactively refreshing before chat turn`);
                await transportOwner["refreshAndPushTokens"]();
            }
        }
        // Ensure subprocess is spawned and ready
        try {
            await transportOwner["ensureSubprocess"]();
        }
        catch (subprocessError) {
            const errorMsg = subprocessError instanceof Error ? subprocessError.message : String(subprocessError);
            transportOwner["debug"](`Failed to spawn Pi subprocess: ${errorMsg}`);
            // If resume failed, clear and try fresh
            if (transportOwner["piSessionId"] && !options?.isRetry && !(subprocessError instanceof InvalidWorkingDirectoryError)) {
                transportOwner["piSessionId"] = null;
                transportOwner["killSubprocess"]();
                transportOwner["clearSessionForRecovery"]();
                const recoveryContext = transportOwner["buildRecoveryContext"]();
                if (recoveryContext) {
                    message = recoveryContext + message;
                    transportOwner["debug"]('Injected recovery context into message');
                }
                await transportOwner["ensureSubprocess"]();
            }
            else {
                throw subprocessError;
            }
        }
        const trimmedMessage = message.trim();
        const compactCommand = parseCompactCommand(trimmedMessage);
        if (compactCommand && !attachments?.length) {
            const { customInstructions } = compactCommand;
            const compactResult = await transportOwner["requestCompact"](customInstructions);
            if (compactResult) {
                yield {
                    type: 'info',
                    message: `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()} tokens)`,
                };
            }
            else {
                yield { type: 'info', message: 'Compacted context to fit within limits' };
            }
            yield { type: 'complete' };
            return;
        }
        // Build system prompt
        const projectContext = transportOwner["resolveProjectContext"]();
        const systemPrompt = await getSystemPromptAsync(undefined, // pinnedPreferencesPrompt
        transportOwner["config"].debugMode, transportOwner["config"].workspace.rootPath, transportOwner["config"].session?.workingDirectory, transportOwner["config"].systemPromptPreset, ROBINSWOOD_BACKEND_NAME, // backendName
        getCoAuthorPreference(), // respect user's includeCoAuthoredBy preference (#576)
        projectContext ?? undefined);
        // Stop can be handled while asynchronous filesystem discovery is pending.
        if (preparationRevision !== transportOwner["promptPreparationRevision"])
            return;
        // Build context from sources
        const sourceContext = transportOwner["sourceManager"].formatSourceState();
        const promptModeDiagnostics = getPermissionModeDiagnostics(transportOwner["_sessionId"]);
        transportOwner["debug"](`[ModeSnapshot] sessionId=${transportOwner["_sessionId"]} chatPrompt mode=${promptModeDiagnostics.permissionMode} ` +
            `modeVersion=${promptModeDiagnostics.modeVersion} changedBy=${promptModeDiagnostics.lastChangedBy} changedAt=${promptModeDiagnostics.lastChangedAt}`);
        // Build context parts using centralized PromptBuilder, split into stable
        // vs volatile (issue #862). Stable blocks (workspace capabilities, working
        // directory) stay in the cached system prefix; volatile blocks (date/time,
        // session_state, source state) ride the user-message tail so a per-turn
        // re-stamp doesn't invalidate the prompt cache. buildVolatileContextParts
        // consumes the one-shot mode-change signal, so it is called exactly once.
        const plansFolderPath = getSessionPlansPath(transportOwner["config"].workspace.rootPath, transportOwner["_sessionId"]);
        const stableParts = transportOwner["promptBuilder"].buildStableContextParts();
        const volatileParts = transportOwner["promptBuilder"].buildVolatileContextParts({ plansFolderPath }, sourceContext);
        // Process attachments
        const attachmentParts: string[] = [];
        const images: Array<{
            type: string;
            data: string;
            mimeType: string;
        }> = [];
        for (const att of attachments || []) {
            if (att.mimeType?.startsWith('image/') && att.base64) {
                images.push({
                    type: 'image',
                    data: att.base64,
                    mimeType: att.mimeType,
                });
            }
            else if (att.mimeType?.startsWith('image/') && (att.storedPath || att.path)) {
                attachmentParts.push(`[Attached image: ${att.name}]\n[Stored at: ${att.storedPath || att.path}]`);
            }
            else if (att.mimeType === 'application/pdf' && att.storedPath) {
                attachmentParts.push(`[Attached PDF: ${att.name}]\n[Stored at: ${att.storedPath}]`);
            }
            else if (att.storedPath) {
                let pathInfo = `[Attached file: ${att.name}]\n[Stored at: ${att.storedPath}]`;
                if (att.markdownPath) {
                    pathInfo += `\n[Markdown version: ${att.markdownPath}]`;
                }
                attachmentParts.push(pathInfo);
            }
        }
        // System prompt carries only stable context (issue #862): the system block
        // is pi-ai's cache prefix before all history, so anything volatile here
        // re-stamps the prefix every turn and drops cacheRead to 0. Volatile blocks
        // ride the user-message tail instead — exactly as the Claude path already
        // does (buildTextPrompt / buildSDKUserMessage append context to the tail).
        const fullSystemPrompt = [
            systemPrompt,
            ...stableParts,
        ].filter(Boolean).join('\n\n');
        // User message: volatile context + attachments + the actual message
        // (skill read directive is already prepended to message by BaseAgent.chat())
        const userParts = [
            ...volatileParts,
            ...attachmentParts,
            message,
        ].filter(Boolean);
        const userMessage = userParts.join('\n\n');
        if (preparationRevision !== transportOwner["promptPreparationRevision"])
            return;
        // Send prompt to subprocess
        const turnId = `turn-${++transportOwner["rpcIdCounter"]}`;
        providerHandoffTurnId = turnId;
        transportOwner["pendingProviderHandoffs"].set(turnId, transportOwner["captureProviderHandoffAcknowledgement"]());
        transportOwner["pendingProviderDispatchRejections"].set(turnId, transportOwner["captureProviderDispatchRejection"]());
        const acknowledgeUncertainDispatch = transportOwner["captureProviderDispatchUncertainAcknowledgement"]();
        try {
            const accepted = await transportOwner["performProviderDispatchWriteAhead"](() => {
                if (preparationRevision !== transportOwner["promptPreparationRevision"]) {
                    throw new ProviderDispatchRejectedError('Pi prompt preparation changed before provider dispatch');
                }
                return transportOwner["send"]({
                    type: 'prompt',
                    id: turnId,
                    message: userMessage,
                    systemPrompt: fullSystemPrompt,
                    images: images.length > 0 ? images : undefined,
                    modelRoutePinned: transportOwner["modelRoutePinned"](),
                });
            });
            // Test doubles historically returned void; only the real send path's
            // explicit false means the prompt was dropped before reaching stdin.
            if (accepted === false) {
                throw new ProviderDispatchRejectedError('Pi subprocess stdin is not writable');
            }
            // The child now owns the prompt, but its correlated preflight result
            // travels back on stdout. Stop in that inter-process window must not
            // restore/replay a delivery that the child may already have accepted.
            acknowledgeUncertainDispatch();
        }
        catch (error) {
            transportOwner["pendingProviderHandoffs"].delete(turnId);
            transportOwner["pendingProviderDispatchRejections"].delete(turnId);
            throw error;
        }
        // Yield events as they arrive. The source-activation drain controller
        // captures a pending restart on the first triggering tool_result and
        // drains sibling tool_results from the same parallel-tool batch before
        // firing `source_activated` + `forceAbort` — Pi's subprocess only picks
        // up new proxy tools on the next handlePrompt, so the restart is needed
        // here too. Without the drain, sibling tool_results from parallel
        // source_test calls are lost (#790).
        const sourceActivationDrain = new SourceActivationDrainController('fire-on-non-tool-result');
        for await (const event of transportOwner["eventQueue"].drain()) {
            // Pre-yield check: when we're past capture and the incoming event is
            // not a tool_result, fire BEFORE yielding it (the event belongs to
            // the about-to-be-aborted next turn — letting it through would leak
            // a fragment of the cancelled response into the session journal).
            const preFire = sourceActivationDrain.shouldFireBeforeEvent(event);
            if (preFire) {
                transportOwner["debug"](`source_test activated "${preFire.sourceSlug}", drained sibling tool_results, restarting turn`);
                yield preFire;
                transportOwner["forceAbort"](AbortReason.SourceActivated);
                return;
            }
            if (sourceActivationDrain.observe(event, () => transportOwner["consumePendingSourceActivationRestart"]())) {
                yield event;
                continue;
            }
            yield event;
        }
        // Stream-end fallback: queue drained naturally with a captured restart
        // still pending. Fire and return (no further events expected).
        const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
        if (sourceActivationFireAtEnd) {
            transportOwner["debug"](`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", stream ended with pending restart, restarting turn`);
            yield sourceActivationFireAtEnd;
            transportOwner["forceAbort"](AbortReason.SourceActivated);
            return;
        }
    }
    catch (error) {
        if (error instanceof Error && !(error instanceof InvalidWorkingDirectoryError) && error.message.includes('abort')) {
            if (transportOwner["abortReason"] === AbortReason.PlanSubmitted) {
                return;
            }
            if (transportOwner["abortReason"] === AbortReason.AuthRequest) {
                return;
            }
            return;
        }
        const errorObj = error instanceof Error ? error : new Error(String(error));
        if (errorObj instanceof PiRuntimeInterruptedError) {
            yield {
                type: 'runtime_interrupted',
                message: errorObj.message,
                code: errorObj.interruptionCode,
            };
            yield { type: 'complete' };
            return;
        }
        const typedError = transportOwner["parsePiError"](errorObj);
        if (typedError.code !== 'unknown_error') {
            yield { type: 'typed_error', error: typedError };
        }
        else {
            yield { type: 'error', message: errorObj.message };
        }
        yield { type: 'complete' };
    }
    finally {
        if (providerHandoffTurnId) {
            transportOwner["pendingProviderHandoffs"].delete(providerHandoffTurnId);
            transportOwner["pendingProviderDispatchRejections"].delete(providerHandoffTurnId);
        }
        transportOwner["_isProcessing"] = false;
    }
}
