import type { SessionOperationContext } from '../operation-context.ts';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { reportBackendAuthUnavailable as sessionOpReportBackendAuthUnavailable } from './is-managed-session-yolo.ts';

export function installRuntimeDebugCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, isCurrentRuntime: () => boolean) {
    // ============================================================
    // Post-construction: debug callback, auth callback, postInit()
    // ============================================================
    managed.agent!.onDebug = (msg: string) => {
        // PiAgent is the sole producer. Requiring its exact prefix prevents a
        // subprocess stderr line containing the marker from forging an error.
        const runtimeErrorPrefix = '[pi] __RUNTIME_ERROR__';
        if (msg.startsWith(runtimeErrorPrefix)) {
            const payloadRaw = msg.slice(runtimeErrorPrefix.length);
            try {
                const payload = JSON.parse(payloadRaw) as {
                    kind?: string;
                    code?: number | null;
                    signal?: string | null;
                    stderrTail?: string;
                };
                sessionLog.error('Agent runtime subprocess failed', {
                    sessionId: managed.id,
                    kind: payload.kind ?? 'unknown',
                    code: payload.code,
                    signal: payload.signal,
                    ...(payload.stderrTail
                        ? { stderrTail: redactSecretLikeMaterial(payload.stderrTail).slice(-4000) }
                        : {}),
                });
            }
            catch {
                sessionLog.error('Agent runtime subprocess failed', {
                    sessionId: managed.id,
                    kind: 'invalid_runtime_diagnostic',
                });
            }
            return;
        }
        const marker = '__PERMISSION_BLOCK__';
        if (msg.includes(marker)) {
            const idx = msg.indexOf(marker);
            const payloadRaw = msg.slice(idx + marker.length);
            try {
                const payload = JSON.parse(payloadRaw) as {
                    sessionId: string;
                    toolName: string;
                    effectiveMode: string;
                    modeVersion: number;
                    changedBy: string;
                    changedAt: string;
                    reason: string;
                };
                sessionLog.info('Tool blocked by permission mode', payload);
                return;
            }
            catch {
                // fall through to plain logging when payload parsing fails
            }
        }
        sessionLog.info(msg);
    };
    // Unified auth callback — replaces per-backend onChatGptAuthRequired/onGithubAuthRequired
    managed.agent!.onBackendAuthRequired = (reason: string) => {
        if (!isCurrentRuntime())
            return;
        sessionLog.warn(`Backend auth required for session ${managed.id}: ${reason}`);
        sessionOpReportBackendAuthUnavailable(sessionOperationContext, managed, `Authentication required: ${reason}`);
    };
}


