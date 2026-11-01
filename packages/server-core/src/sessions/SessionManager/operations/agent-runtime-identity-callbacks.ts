import type { SessionOperationContext } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { flushSessionPersistenceInBackground as sessionOpFlushSessionPersistenceInBackground } from './persistence-barriers.ts';

export function createRuntimeIdentityCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, isCurrentRuntime: () => boolean) {
    const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        if (!isCurrentRuntime())
            return;
        managed.sdkSessionId = sdkSessionId;
        // Retire branch-only fork metadata now that child session is established
        if (managed.branchFromSdkSessionId) {
            sessionLog.info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`);
            managed.branchFromSdkSessionId = undefined;
            managed.branchFromSdkCwd = undefined;
            managed.branchFromSdkTurnId = undefined;
        }
        else {
            sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`);
        }
        sessionOperationContext.owner["persistSession"](managed);
        sessionOpFlushSessionPersistenceInBackground(sessionOperationContext, managed, 'SDK session ID update');
    };
    const onSdkSessionIdCleared = () => {
        if (!isCurrentRuntime())
            return;
        managed.sdkSessionId = undefined;
        sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`);
        sessionOperationContext.owner["persistSession"](managed);
        sessionOpFlushSessionPersistenceInBackground(sessionOperationContext, managed, 'SDK session ID clear');
    };
    const onBranchForkInvalidated = () => {
        if (!isCurrentRuntime())
            return;
        managed.sdkSessionId = undefined;
        managed.branchFromSdkSessionId = undefined;
        managed.branchFromSdkCwd = undefined;
        managed.branchFromSdkTurnId = undefined;
        sessionLog.info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`);
        sessionOperationContext.owner["persistSession"](managed);
        sessionOpFlushSessionPersistenceInBackground(sessionOperationContext, managed, 'branch fork invalidation');
    };
    return { onSdkSessionIdUpdate, onSdkSessionIdCleared, onBranchForkInvalidated };
}


