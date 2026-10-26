import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { resetClaudeConfigCheck } from "../options.ts";
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
// Plan types are used by UI components; not needed in craft-agent.ts since Safe Mode is user-controlled
import { parseError } from "../errors.ts";
import { redactDiagnosticText, runErrorDiagnostics } from "../diagnostics.ts";
import { type AuthType } from "../../config/storage.ts";
import { debug } from "../../utils/debug.ts";
import { existsSync } from "node:fs";
import { isExistingDirectory, extractSdkReportedBinaryPath, isSpawnEnoent as detectSpawnEnoent } from "../spawn-helpers.ts";
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
// Documentation is served via local files at ~/.craft-agent/docs/
// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from "@craft-agent/core/types";
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
import { AbortReason } from "../core/index.ts";
import type { ClaudeAgent } from '../claude-agent.ts';
import { shouldAutomaticallyRecoverClaudeProcessInterruption, buildWindowsSkillsDirError } from './shared.ts';
import type { ClaudeQueryFailureContext } from './shared.ts';

export async function* recoverClaudeQueryError(transportOwner: ClaudeAgent, sdkError: unknown, context: ClaudeQueryFailureContext): AsyncGenerator<AgentEvent> {
    const { receivedAssistantContent, wasResuming, _isRetry, userMessage, attachments, suppressedSessionExpiredError, suppressedBranchCutoffError, resolvedBinaryPath, resolvedCwd } = context;
    // Debug: log inner catch trigger (stderr to avoid SDK JSON pollution)
    console.error(`[ClaudeAgent] INNER CATCH triggered: ${sdkError instanceof Error ? sdkError.message : String(sdkError)}`);
    // Handle user interruption
    if (sdkError instanceof AbortError) {
        const reason = transportOwner["lastAbortReason"];
        transportOwner["lastAbortReason"] = null; // Clear for next time
        // If interrupted before receiving any assistant content AND this was the first message,
        // clear session ID to prevent broken resume state where SDK session file is empty/invalid.
        // For later messages (messageCount > 0), keep the session ID to preserve conversation history.
        // The SDK session file should have valid previous turns we can resume from.
        if (!receivedAssistantContent && transportOwner["sessionId"]) {
            // Check if there are previous messages (completed turns) in this session
            // If yes, keep the session ID to preserve history on resume
            const hasCompletedTurns = transportOwner["config"].getRecoveryMessages && transportOwner["config"].getRecoveryMessages().length > 0;
            if (!hasCompletedTurns) {
                // First message was interrupted before any response - SDK session is empty/corrupt
                debug('[SESSION_DEBUG] First message interrupted before assistant content - clearing sdkSessionId:', transportOwner["sessionId"]);
                transportOwner["sessionId"] = null;
                transportOwner["config"].onSdkSessionIdCleared?.();
            }
            else {
                // Later message interrupted - SDK session has valid history, keep it for resume
                debug('[SESSION_DEBUG] Later message interrupted - keeping sdkSessionId for history preservation:', transportOwner["sessionId"]);
            }
        }
        // Only emit "Interrupted" status for user-initiated stops
        // Plan submissions and redirects should be silent
        if (reason === AbortReason.UserStop) {
            yield { type: 'status', message: 'Interrupted' };
        }
        yield { type: 'complete' };
        return;
    }
    // Get error message regardless of error type
    // Note: SDK text errors like "API Error: 402..." are primarily handled in useAgent.ts
    // via text_complete event. This is a fallback for errors that don't emit text first.
    // parseError() will detect status codes (402, 401, etc.) in the raw message.
    const rawErrorMsg = sdkError instanceof Error ? sdkError.message : String(sdkError);
    const errorMsg = rawErrorMsg.toLowerCase();
    // Debug logging - always log the actual error and context
    transportOwner["onDebug"]?.(`Error in chat: ${rawErrorMsg}`);
    transportOwner["onDebug"]?.(`Context: wasResuming=${wasResuming}, isRetry=${_isRetry}`);
    // Check for auth errors - these won't be fixed by clearing session
    const isAuthError = errorMsg.includes('unauthorized') ||
        errorMsg.includes('401') ||
        errorMsg.includes('authentication failed') ||
        errorMsg.includes('invalid api key') ||
        errorMsg.includes('invalid x-api-key');
    if (isAuthError) {
        // Auth errors surface immediately - session manager handles retry by recreating agent
        const typedError = parseError(new Error(rawErrorMsg));
        yield { type: 'typed_error', error: typedError };
        yield { type: 'complete' };
        return;
    }
    // Rate limit errors - don't retry immediately, surface to user
    const isRateLimitError = errorMsg.includes('429') ||
        errorMsg.includes('rate limit') ||
        errorMsg.includes('too many requests');
    if (isRateLimitError) {
        // Parse to typed error using the captured/processed error message
        const typedError = parseError(new Error(rawErrorMsg));
        yield { type: 'typed_error', error: typedError };
        yield { type: 'complete' };
        return;
    }
    // Check for billing/payment errors (402) - don't retry these
    const isBillingError = errorMsg.includes('402') ||
        errorMsg.includes('payment required') ||
        errorMsg.includes('billing');
    if (isBillingError) {
        // Parse to typed error using the captured/processed error message, not the original SDK error
        // This ensures parseError sees "402 Payment required" instead of "process exited with code 1"
        const typedError = parseError(new Error(rawErrorMsg));
        yield { type: 'typed_error', error: typedError };
        yield { type: 'complete' };
        return;
    }
    // Check for .claude.json corruption — the SDK subprocess crashes if this file
    // is empty, BOM-encoded, or contains invalid JSON. Two error patterns:
    //   1. "CLI output was not valid JSON" — CLI wrote plain-text error to stdout
    //   2. "process exited with code 1" with stderr mentioning config corruption
    // See: claude-code#14442 (BOM), #2593 (empty file), #18998 (race condition)
    const stderrForConfigCheck = transportOwner["lastStderrOutput"].join('\n').toLowerCase();
    const isConfigCorruption = (errorMsg.includes('not valid json') && (errorMsg.includes('claude') || errorMsg.includes('configuration'))) ||
        (errorMsg.includes('process exited with code') && (stderrForConfigCheck.includes('claude.json') ||
            stderrForConfigCheck.includes('configuration file') ||
            stderrForConfigCheck.includes('corrupted')));
    if (isConfigCorruption && !_isRetry) {
        debug('[ClaudeAgent] Detected .claude.json corruption, repairing and retrying...');
        // Reset the once-per-process guard so ensureClaudeConfig() runs again
        // on the retry — it will repair the file before the next subprocess spawn
        resetClaudeConfigCheck();
        yield { type: 'info', message: 'Repairing configuration file...' };
        yield* transportOwner["chat"](userMessage, attachments, { isRetry: true });
        return;
    }
    // Check for SDK process errors - these often wrap underlying billing/auth issues
    // The SDK's internal Claude Code process exits with code 1 for various API errors
    const isProcessError = errorMsg.includes('process exited with code');
    // Include captured stderr in diagnostics (used by multiple checks below)
    const stderrContext = transportOwner["lastStderrOutput"].length > 0
        ? transportOwner["lastStderrOutput"].join('\n')
        : undefined;
    // [SESSION_DEBUG] Comprehensive logging for session recovery investigation
    debug('[SESSION_DEBUG] === ERROR HANDLER ENTRY ===');
    debug('[SESSION_DEBUG] errorMsg:', errorMsg);
    debug('[SESSION_DEBUG] rawErrorMsg:', rawErrorMsg);
    debug('[SESSION_DEBUG] isProcessError:', isProcessError);
    debug('[SESSION_DEBUG] wasResuming:', wasResuming);
    debug('[SESSION_DEBUG] _isRetry:', _isRetry);
    debug('[SESSION_DEBUG] this.sessionId:', transportOwner["sessionId"]);
    debug('[SESSION_DEBUG] lastStderrOutput length:', transportOwner["lastStderrOutput"].length);
    debug('[SESSION_DEBUG] lastStderrOutput:', transportOwner["lastStderrOutput"].join('\n'));
    // Check for expired session error - SDK session no longer exists server-side.
    // This happens when sessions expire (TTL) or are cleaned up by Anthropic.
    // Check error message, raw error, AND stderr — the SDK may propagate the error
    // through different paths depending on version/timing.
    const SESSION_EXPIRED_MARKER = 'No conversation found with session ID';
    const isSessionExpired = suppressedSessionExpiredError || // stream-level suppression already detected this
        errorMsg.includes(SESSION_EXPIRED_MARKER) ||
        (rawErrorMsg || '').includes(SESSION_EXPIRED_MARKER) ||
        (stderrContext || '').includes(SESSION_EXPIRED_MARKER);
    debug('[SESSION_DEBUG] isSessionExpired:', isSessionExpired, 'suppressedSessionExpiredError:', suppressedSessionExpiredError);
    // Missing-UUID fallback may surface as a generic process-exit error in catch,
    // even after we suppressed the underlying stream error event above.
    // If branch cutoff failed but child session is established, retry once without cutoff.
    if (suppressedBranchCutoffError && wasResuming && !_isRetry && transportOwner["sessionId"]) {
        debug('[SESSION_DEBUG] >>> TAKING PATH: missing-UUID branch-cutoff fallback from catch');
        yield { type: 'info', message: 'Branch point was compacted on server, retrying with nearest available context...' };
        yield* transportOwner["chat"](userMessage, attachments);
        return;
    }
    if (isSessionExpired && wasResuming && !_isRetry) {
        debug('[SESSION_DEBUG] >>> TAKING PATH: Session expired recovery');
        const wasBranchFork = !!transportOwner["branchFromSdkSessionId"];
        console.error('[ClaudeAgent] SDK session expired server-side, clearing and retrying fresh');
        debug('[ClaudeAgent] SDK session expired server-side, clearing and retrying fresh');
        if (wasBranchFork) {
            // Branch-fork failure: route through the shared helper so the
            // four fork fields are persisted atomically (avoids next launch
            // reloading the dead parent and re-failing).
            yield* transportOwner["recoverFromStaleBranchFork"](userMessage, attachments, /* isPreSpawn */ false);
            return;
        }
        // Regular resume failure: clear sessionId and retry with raw recovery context.
        transportOwner["sessionId"] = null;
        transportOwner["config"].onSdkSessionIdCleared?.();
        transportOwner["pinnedPreferencesPrompt"] = null;
        transportOwner["pinnedIncludeCoAuthoredBy"] = null;
        transportOwner["pinnedProjectContext"] = null;
        transportOwner["preferencesDriftNotified"] = false;
        let retryMessage = userMessage;
        const recoveryContext = transportOwner["buildRecoveryContext"]();
        if (recoveryContext)
            retryMessage = recoveryContext + userMessage;
        yield { type: 'info', message: 'Session expired, restoring context...' };
        yield* transportOwner["chat"](retryMessage, attachments, { isRetry: true });
        return;
    }
    // ─────────────────────────────────────────────────────────────────
    // ENOENT handling — runs BEFORE the `if (isProcessError)` gate
    // because the SDK throws spawn ENOENT as a `ReferenceError` with
    // message "Claude Code native binary not found at …", which does
    // not contain "process exited with code". Pre-uplift, the
    // detection lived inside `isProcessError` and never fired for the
    // case we actually care about.
    // ─────────────────────────────────────────────────────────────────
    const spawnError = sdkError as NodeJS.ErrnoException;
    const isSpawnEnoent = detectSpawnEnoent({
        errorCode: spawnError.code,
        errorSyscall: spawnError.syscall,
        rawErrorMsg,
        stderr: stderrContext,
    });
    if (isSpawnEnoent) {
        const reportedBinaryPath = extractSdkReportedBinaryPath(rawErrorMsg || '');
        const { getPathToClaudeCodeExecutable } = await import("../options.ts");
        const probedBinary = reportedBinaryPath || resolvedBinaryPath || getPathToClaudeCodeExecutable();
        const probedCwd = resolvedCwd || undefined;
        const binaryExists = probedBinary ? existsSync(probedBinary) : false;
        const cwdExists = probedCwd ? isExistingDirectory(probedCwd) : false;
        debug('[ClaudeAgent] ENOENT detected', {
            probedBinary, probedCwd, binaryExists, cwdExists,
            reportedBinaryPath,
            errorCode: spawnError.code, errorSyscall: spawnError.syscall,
        });
        // Stale cwd plus a branch parent → route to recovery (covers the
        // rare race where the pre-spawn guard didn't catch a cwd that
        // vanished between check and spawn).
        if (!cwdExists && !_isRetry && transportOwner["branchFromSdkSessionId"]) {
            yield* transportOwner["recoverFromStaleBranchFork"](userMessage, attachments, /* isPreSpawn */ false);
            return;
        }
        // First attempt: retry once after 2s. Covers transient causes
        // (auto-update bundle-swap window, sandbox/quarantine, race)
        // regardless of which path looks missing.
        if (!_isRetry) {
            console.error('[ClaudeAgent] spawn ENOENT, retrying in 2s', {
                sessionId: transportOwner["config"].session?.id,
                probedBinary, probedCwd,
                errorCode: spawnError.code, errorSyscall: spawnError.syscall,
                stderr: (stderrContext || '').slice(0, 200),
            });
            yield { type: 'info', message: 'Reconnecting after update...' };
            await new Promise(r => setTimeout(r, 2000));
            yield* transportOwner["chat"](userMessage, attachments, { isRetry: true });
            return;
        }
        // Retry exhausted: surface a typed error pointed at the more-likely
        // cause. Cwd missing is more actionable when the binary is fine
        // (we can recover from a parent summary); otherwise blame the
        // binary (reinstall is the user's fix).
        const isCwdCause = !cwdExists && binaryExists;
        yield {
            type: 'typed_error',
            error: isCwdCause ? {
                code: 'sdk_cwd_missing',
                title: 'Branch source unavailable on this machine',
                message: "The folder this branched session was forked from doesn't exist on this machine. " +
                    'This typically happens after importing a session from another workspace. ' +
                    'Retrying will start a fresh fork from a summary of the parent conversation.',
                details: [
                    probedCwd ? `Subprocess cwd: ${probedCwd}` : '',
                    probedBinary ? `Binary: ${probedBinary} (${binaryExists ? 'exists' : 'missing'})` : '',
                ].filter(Boolean) as string[],
                actions: [{ key: 'r', label: 'Retry', action: 'retry' as const }],
                canRetry: true,
                retryDelayMs: 1000,
                originalError: rawErrorMsg,
            } : {
                code: 'sdk_binary_missing',
                title: 'Claude Code binary missing from app bundle',
                message: 'The Claude Agent SDK binary expected on disk is not present. ' +
                    'This usually means the app bundle is incomplete (interrupted download, partial update, ' +
                    'or a security tool removed it). Reinstalling Robb Agents typically fixes this.',
                details: [
                    probedBinary ? `Expected binary: ${probedBinary}` : 'Binary path: unknown',
                    probedCwd ? `Subprocess cwd: ${probedCwd} (${cwdExists ? 'exists' : 'missing'})` : '',
                ].filter(Boolean) as string[],
                actions: [{ key: 'r', label: 'Retry', action: 'retry' as const }],
                canRetry: true,
                retryDelayMs: 1000,
                originalError: rawErrorMsg,
            },
        };
        yield { type: 'complete' };
        return;
    }
    if (isProcessError) {
        if (stderrContext) {
            debug('[SDK process error] Captured stderr:', stderrContext);
        }
        // Check for Windows SDK setup error (missing .claude/skills directory)
        const windowsSkillsError = buildWindowsSkillsDirError(stderrContext || rawErrorMsg);
        if (windowsSkillsError) {
            yield windowsSkillsError;
            yield { type: 'complete' };
            return;
        }
        debug('[SESSION_DEBUG] >>> TAKING PATH: Run diagnostics (not session expired)');
        // Run diagnostics to identify specific cause (2s timeout)
        // Derive authType from the default LLM connection
        const { getDefaultLlmConnection, getLlmConnection } = await import("../../config/storage.ts");
        const defaultConnSlug = getDefaultLlmConnection();
        const connection = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null;
        // Map connection authType to legacy AuthType format for diagnostics
        let diagnosticAuthType: AuthType | undefined;
        if (connection) {
            if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
                diagnosticAuthType = 'api_key';
            }
            else if (connection.authType === 'oauth') {
                diagnosticAuthType = 'oauth_token';
            }
        }
        const diagnostics = await runErrorDiagnostics({
            authType: diagnosticAuthType,
            workspaceId: transportOwner["config"].workspace?.id,
            rawError: stderrContext || rawErrorMsg,
            providerType: transportOwner["config"].providerType || connection?.providerType,
            baseUrl: connection?.baseUrl,
        });
        debug('[SESSION_DEBUG] diagnostics.code:', diagnostics.code);
        debug('[SESSION_DEBUG] diagnostics.title:', diagnostics.title);
        debug('[SESSION_DEBUG] diagnostics.message:', diagnostics.message);
        // Get recovery actions based on diagnostic code
        const actions = diagnostics.code === 'token_expired' || diagnostics.code === 'mcp_unreachable'
            ? [
                { key: 'w', label: 'Open workspace menu', command: '/workspace' },
                { key: 'r', label: 'Retry', action: 'retry' as const },
            ]
            : diagnostics.code === 'invalid_credentials' || diagnostics.code === 'billing_error'
                ? [
                    { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' as const },
                ]
                : [
                    { key: 'r', label: 'Retry', action: 'retry' as const },
                    { key: 's', label: 'Check settings', command: '/settings', action: 'settings' as const },
                ];
        const safeStderrContext = stderrContext ? redactDiagnosticText(stderrContext) : undefined;
        const safeRawErrorMessage = redactDiagnosticText(rawErrorMsg);
        if (shouldAutomaticallyRecoverClaudeProcessInterruption(diagnostics.code)) {
            yield {
                type: 'runtime_interrupted',
                message: diagnostics.message,
                code: 'process_exit',
            };
            yield { type: 'complete' };
            return;
        }
        yield {
            type: 'typed_error',
            error: {
                code: diagnostics.code,
                title: diagnostics.title,
                message: diagnostics.message,
                // Subprocess stderr is useful, but must never become a credential channel.
                details: safeStderrContext
                    ? [...(diagnostics.details || []), `SDK stderr: ${safeStderrContext}`]
                    : diagnostics.details,
                actions,
                canRetry: diagnostics.code !== 'billing_error' && diagnostics.code !== 'invalid_credentials',
                retryDelayMs: 1000,
                originalError: safeStderrContext || safeRawErrorMessage,
            },
        };
        yield { type: 'complete' };
        return;
    }
    // Session-related retry: only if we were resuming and haven't retried yet
    debug('[SESSION_DEBUG] isProcessError=false, checking wasResuming fallback');
    if (wasResuming && !_isRetry) {
        debug('[SESSION_DEBUG] >>> TAKING PATH: wasResuming fallback retry');
        const wasBranchFork = !!transportOwner["branchFromSdkSessionId"];
        if (wasBranchFork) {
            // Generic error during a fork attempt: route through the shared
            // helper so all four fork fields are persisted atomically and
            // the parent summary is injected into the retry.
            yield* transportOwner["recoverFromStaleBranchFork"](userMessage, attachments, /* isPreSpawn */ false);
            return;
        }
        // Regular resume failure (no branch fork): clear sessionId only.
        transportOwner["sessionId"] = null;
        transportOwner["config"].onSdkSessionIdCleared?.();
        transportOwner["pinnedPreferencesPrompt"] = null;
        transportOwner["pinnedIncludeCoAuthoredBy"] = null;
        transportOwner["pinnedProjectContext"] = null;
        transportOwner["preferencesDriftNotified"] = false;
        let retryMessage = userMessage;
        const recoveryContext = transportOwner["buildRecoveryContext"]();
        if (recoveryContext)
            retryMessage = recoveryContext + userMessage;
        const statusMessage = errorMsg.includes('session') || errorMsg.includes('resume')
            ? 'Conversation sync failed, restoring context...'
            : 'Request failed, retrying with context...';
        yield { type: 'info', message: statusMessage };
        yield* transportOwner["chat"](retryMessage, attachments, { isRetry: true });
        return;
    }
    debug('[SESSION_DEBUG] >>> TAKING PATH: Final fallback (show generic error)');
    // Retry also failed, or wasn't resuming - show generic error
    // (Auth, billing, and rate limit errors are handled above)
    const rawMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);
    yield { type: 'error', message: rawMessage };
    yield { type: 'complete' };
    return;
}
