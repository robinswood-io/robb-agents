import type { AgentInstance } from '../runtime-types.ts';
import type { Message } from '@craft-agent/core/types';

export interface ProviderTurnState {
    chatStarted: boolean;
    providerHandoffAgent: AgentInstance | undefined;
    providerHandoffCallback: (() => void) | undefined;
    providerHandoffDurabilityPromise: Promise<void> | undefined;
    rejectProviderHandoffDurabilityFailure: (error: unknown) => void;
    readonly providerHandoffDurabilityFailure: Promise<never>;
    previousProviderHandoffCallback: (() => void) | null | undefined;
    providerWriteAheadCallback: (() => Promise<void>) | undefined;
    previousProviderWriteAheadCallback: (() => Promise<void>) | null | undefined;
    providerWriteAheadMarker: NonNullable<Message['providerDispatch']> | undefined;
    providerWriteAheadReturned: boolean;
    providerDispatchRejected: boolean;
    exactProviderWriteAheadMatches: () => boolean;
    rollbackProviderWriteAhead: () => Promise<boolean>;
    clearAcceptedProviderWriteAhead: () => Promise<boolean>;
    providerDispatchRejectedCallback: (() => void) | undefined;
    previousProviderDispatchRejectedCallback: (() => void) | null | undefined;
    providerDispatchUncertainCallback: (() => void) | undefined;
    previousProviderDispatchUncertainCallback: (() => void) | null | undefined;
    providerHandoffArmed: boolean;
    providerHandoffCancellationEpoch: number;
    preProviderTerminalError: Error | undefined;
    readonly pendingToolReceipts: Set<string>;
}

/** The existing volatile provider variables, scoped to a single admitted turn. */
export function createProviderTurnState(): ProviderTurnState {
    let rejectProviderHandoffDurabilityFailure!: (error: unknown) => void;
    const providerHandoffDurabilityFailure = new Promise<never>((_resolve, reject) => {
        rejectProviderHandoffDurabilityFailure = reject;
    });
    void providerHandoffDurabilityFailure.catch(() => { });
    return {
        chatStarted: false,
        providerHandoffAgent: undefined,
        providerHandoffCallback: undefined,
        providerHandoffDurabilityPromise: undefined,
        rejectProviderHandoffDurabilityFailure,
        providerHandoffDurabilityFailure,
        previousProviderHandoffCallback: undefined,
        providerWriteAheadCallback: undefined,
        previousProviderWriteAheadCallback: undefined,
        providerWriteAheadMarker: undefined,
        providerWriteAheadReturned: false,
        providerDispatchRejected: false,
        exactProviderWriteAheadMatches: (): boolean => false,
        rollbackProviderWriteAhead: async (): Promise<boolean> => false,
        clearAcceptedProviderWriteAhead: async (): Promise<boolean> => false,
        providerDispatchRejectedCallback: undefined,
        previousProviderDispatchRejectedCallback: undefined,
        providerDispatchUncertainCallback: undefined,
        previousProviderDispatchUncertainCallback: undefined,
        providerHandoffArmed: false,
        providerHandoffCancellationEpoch: 0,
        preProviderTerminalError: undefined,
        pendingToolReceipts: new Set<string>(),
    };
}
