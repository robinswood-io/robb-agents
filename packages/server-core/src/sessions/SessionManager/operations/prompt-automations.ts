import type { SessionOperationContext } from '../operation-context.ts';
import { resolveAutomationMentions } from '../policy.ts';
import type { ExecutePromptAutomationInput } from '@craft-agent/server-core/handlers';
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend';
import { ensureLabelsExist } from '@craft-agent/shared/labels/crud';
import { sessionLog } from '../runtime-platform.ts';
import { trackManagerOperation as sessionOpTrackManagerOperation } from './track-session-operation.ts';

/**
 * Execute a prompt automation by creating a new session and sending the prompt.
 *
 * The options-object form replaced the previous positional-args signature
 * once the param list outgrew readability — `thinkingLevel` was the trigger.
 * When `thinkingLevel` is omitted, `createSession` falls back to the
 * workspace default (then DEFAULT_THINKING_LEVEL).
 */
async function sessionOpExecutePromptAutomation(sessionOperationContext: SessionOperationContext, input: ExecutePromptAutomationInput): Promise<{
    sessionId: string;
}> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOpPerformExecutePromptAutomation(sessionOperationContext, input));
}

async function sessionOpPerformExecutePromptAutomation(sessionOperationContext: SessionOperationContext, input: ExecutePromptAutomationInput): Promise<{
    sessionId: string;
}> {
    const { workspaceId, workspaceRootPath, prompt, labels, permissionMode, mentions, llmConnection, model, thinkingLevel, automationName, telegramTopic, waitForCompletion, } = input;
    // Warn if llmConnection was specified but doesn't resolve
    if (llmConnection) {
        const connection = resolveSessionConnection(llmConnection);
        if (!connection) {
            sessionLog.warn(`[Automations] llmConnection "${llmConnection}" not found, using default`);
        }
    }
    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? resolveAutomationMentions(workspaceRootPath, mentions) : undefined;
    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
        ? ensureLabelsExist(workspaceRootPath, labels)
        : labels;
    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`;
    const sessionName = automationName || fallback;
    // Create a new session for this automation
    const session = await sessionOperationContext.owner.createSession(workspaceId, {
        name: sessionName,
        labels: resolvedLabels,
        permissionMode: permissionMode || 'safe',
        enabledSourceSlugs: resolved?.sourceSlugs,
        llmConnection,
        model,
        thinkingLevel,
    });
    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = sessionOperationContext.state.sessions.get(session.id);
    if (managed) {
        managed.triggeredBy = { automationName, timestamp: Date.now() };
        sessionOperationContext.owner["persistSession"](managed);
    }
    // (session_created is emitted by createSession above; triggeredBy is set synchronously
    // before the renderer's hydrate round-trip resolves, so it is observed.)
    // Bind the new session to its Telegram forum topic if the matcher
    // declared `telegramTopic`. Done before `sendMessage` so the first
    // assistant tokens already route through the bound topic. Failure
    // is logged inside the binder; the session continues unbound.
    if (sessionOperationContext.state.automationBinder && telegramTopic && telegramTopic.trim().length > 0) {
        try {
            await sessionOperationContext.state.automationBinder({
                workspaceId,
                sessionId: session.id,
                topicName: telegramTopic.trim(),
            });
        }
        catch (err) {
            sessionLog.warn('[Automations] automation binder threw', {
                sessionId: session.id,
                telegramTopic,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // Send the prompt.
    // Test runs pass `waitForCompletion: false` so we return as soon as the
    // session exists and the prompt is dispatched — otherwise the RPC blocks
    // until the entire turn (including tool calls) finishes and trips the 30s
    // client timeout (craft-agents-oss#943). The session streams live either
    // way; a background failure surfaces in the session UI and is logged here.
    if (waitForCompletion === false) {
        void sessionOperationContext.owner.sendMessage(session.id, prompt, undefined, undefined, {
            skillSlugs: resolved?.skillSlugs,
            internalOrigin: { kind: 'automation' },
        }).catch((err) => {
            sessionLog.error('[Automations] background sendMessage failed for test run', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
            });
        });
        return { sessionId: session.id };
    }
    await sessionOperationContext.owner.sendMessage(session.id, prompt, undefined, undefined, {
        skillSlugs: resolved?.skillSlugs,
        internalOrigin: { kind: 'automation' },
    });
    return { sessionId: session.id };
}

export { sessionOpExecutePromptAutomation as executePromptAutomation };
export { sessionOpPerformExecutePromptAutomation as performExecutePromptAutomation };
