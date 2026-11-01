import { sessionLog } from '../runtime-platform.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';

export async function restoreProviderTurnHooks(
    providerTurnInput: ProviderTurnInput
): Promise<void> {
    const {
        sessionOperationContext,
        managed,
        activeProviderState,
        sendSpan,
    } = providerTurnInput;
activeProviderState.providerHandoffArmed = false;
    if (activeProviderState.providerHandoffAgent && activeProviderState.providerHandoffCallback
        && activeProviderState.providerHandoffAgent.onProviderHandoff === activeProviderState.providerHandoffCallback) {
        activeProviderState.providerHandoffAgent.onProviderHandoff = activeProviderState.previousProviderHandoffCallback ?? null;
    }
    if (activeProviderState.providerHandoffAgent && activeProviderState.providerWriteAheadCallback
        && activeProviderState.providerHandoffAgent.onBeforeProviderDispatch === activeProviderState.providerWriteAheadCallback) {
        activeProviderState.providerHandoffAgent.onBeforeProviderDispatch = activeProviderState.previousProviderWriteAheadCallback ?? null;
    }
    if (activeProviderState.providerHandoffAgent && activeProviderState.providerDispatchRejectedCallback
        && activeProviderState.providerHandoffAgent.onProviderDispatchRejected === activeProviderState.providerDispatchRejectedCallback) {
        activeProviderState.providerHandoffAgent.onProviderDispatchRejected = activeProviderState.previousProviderDispatchRejectedCallback ?? null;
    }
    if (activeProviderState.providerHandoffAgent && activeProviderState.providerDispatchUncertainCallback
        && activeProviderState.providerHandoffAgent.onProviderDispatchUncertain === activeProviderState.providerDispatchUncertainCallback) {
        activeProviderState.providerHandoffAgent.onProviderDispatchUncertain = activeProviderState.previousProviderDispatchUncertainCallback ?? null;
    }
    // Only handle cleanup for unexpected exits (loop break without complete event)
    // Normal completion returns early after calling onProcessingStopped
    // Errors are handled in catch block
    if (managed.isProcessing && managed.processingGeneration === providerTurnInput.myGeneration) {
        sessionLog.info('Finally block cleanup - unexpected exit');
        sendSpan.mark('chat.unexpected_exit');
        sendSpan.end();
        await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
    }
}
