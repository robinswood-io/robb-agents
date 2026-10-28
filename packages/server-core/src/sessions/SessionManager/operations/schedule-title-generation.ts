import type { SessionOperationContext } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { generateTitle as sessionOpGenerateTitle } from './objective-registration.ts';

/**
 * Generate an AI title for a session from the user's first message.
 * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
 * If no agent exists, creates a temporary one using the session's connection.
 */
function sessionOpScheduleTitleGeneration(sessionOperationContext: SessionOperationContext, managed: ManagedSession, userMessage: string): void {
    void sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpGenerateTitle(sessionOperationContext, managed, userMessage)).catch((error: unknown) => {
        // Deletion closes admission synchronously. A title is optional and must
        // never keep a rejected detached-session promise alive as an unhandled
        // background task.
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
            return;
        sessionLog.error(`Background title generation failed for session ${managed.id}:`, error);
    });
}

export { sessionOpScheduleTitleGeneration as scheduleTitleGeneration };
