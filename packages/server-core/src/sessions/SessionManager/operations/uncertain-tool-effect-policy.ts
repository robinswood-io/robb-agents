import { classifyToolEffect, isToolResultError, ToolAdmissionRecoveryError, canonicalTerminalReconciliationToolInput, isObjectiveShellEvidenceCommand, isProvablyReadOnlyShellCommand, TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import type { StoredMessage } from '@craft-agent/shared/sessions';

export function enforceUncertainToolEffectPolicy(managed: ManagedSession, quarantinesUncertainObjectiveEffect: boolean, request: { toolUseId?: string; toolName: string; toolInput: Record<string, unknown> }, safeReceiptInput: Record<string, unknown>, durableMessages: StoredMessage[], toolUseId: string): void {
    if (quarantinesUncertainObjectiveEffect) {
        const permissionsContext = {
            workspaceRootPath: managed.workspace.rootPath,
            activeSourceSlugs: managed.enabledSourceSlugs ?? [],
        };
        const requestedEffect = classifyToolEffect(request.toolName, safeReceiptInput, permissionsContext);
        const isProvenRemoteRead = (toolName: string, input: Record<string, unknown>): boolean => (toolName === 'mcp__rbw-servers__ssh_execute'
            && input["server"] === 'dev'
            && typeof input["cwd"] === 'string'
            && /^\/opt\/ia-webdev\/agent-dev\/worktrees\/orion\/[a-z0-9-]+$/.test(input["cwd"])
            && typeof input["command"] === 'string'
            && isProvablyReadOnlyShellCommand(input["command"]));
        // A previous literal Bash observation can be classified without a
        // workspace permission file. This applies only to persisted prior
        // receipts, never to admitting the proposed new command.
        const priorReceiptIsRead = (toolName: string, input: Record<string, unknown>): boolean => classifyToolEffect(toolName, input, permissionsContext).kind === 'read'
            || isProvenRemoteRead(toolName, input)
            || toolName === 'Bash'
                && typeof input["command"] === 'string'
                && isProvablyReadOnlyShellCommand(input["command"]);
        if (requestedEffect.kind !== 'read' && !isProvenRemoteRead(request.toolName, safeReceiptInput)) {
            const requestedCanonicalInput = canonicalTerminalReconciliationToolInput(safeReceiptInput);
            const objectiveRootMessageId = managed.activeObjective?.userMessageId;
            const objectiveRootIndexes = durableMessages.flatMap((message, index) => (message.type === 'user' && message.id === objectiveRootMessageId ? [index] : []));
            if (objectiveRootIndexes.length !== 1) {
                throw new Error('Automatic recovery exactly-once fence has no unique durable objective root');
            }
            const unresolvedPriorToolReceipt = durableMessages.find((message, index) => {
                // Include earlier admissions from this same recovered turn.
                if (index <= objectiveRootIndexes[0]!
                    || message.type !== 'tool'
                    || message.toolUseId === toolUseId
                    || message.toolStatus !== 'executing'
                    || message.toolResult !== undefined
                    || typeof message.toolName !== 'string')
                    return false;
                const priorInput = message.toolInput
                    && typeof message.toolInput === 'object'
                    && !Array.isArray(message.toolInput)
                    ? message.toolInput
                    : {};
                const { [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: _priorTerminalCapability, ...priorOperationalInput } = priorInput;
                return !priorReceiptIsRead(message.toolName, priorOperationalInput);
            });
            if (unresolvedPriorToolReceipt) {
                throw new ToolAdmissionRecoveryError('Automatic recovery exactly-once fence: an earlier durable tool receipt is still executing without a result, so no new mutation may start. Reconcile its effect read-only; do not retry the mutation or request permission.');
            }
            const completedMatchingMutation = durableMessages.find((message, index) => {
                if (index <= objectiveRootIndexes[0]!
                    || message.type !== 'tool'
                    || message.toolStatus !== 'completed'
                    || message.toolExecuted !== true
                    || message.toolResult === undefined
                    || message.isError === true
                    || isToolResultError(message.toolResult)
                    || typeof message.toolName !== 'string')
                    return false;
                const priorInput = message.toolInput
                    && typeof message.toolInput === 'object'
                    && !Array.isArray(message.toolInput)
                    ? message.toolInput
                    : undefined;
                const { [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: _priorTerminalCapability, ...priorOperationalInput } = priorInput ?? {};
                if (priorReceiptIsRead(message.toolName, priorOperationalInput)) {
                    return false;
                }
                if ((message.toolName === 'Bash' || message.toolName === 'mcp__rbw-servers__ssh_execute')
                    && typeof priorOperationalInput["command"] === 'string'
                    && isObjectiveShellEvidenceCommand(priorOperationalInput["command"])) {
                    try {
                        const parsed: unknown = JSON.parse(message.toolResult);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            const envelope = parsed as Record<string, unknown>;
                            if (envelope["success"] === false || (typeof envelope["code"] === 'number' && envelope["code"] !== 0)) {
                                return false;
                            }
                        }
                    }
                    catch { /* Plain text or malformed results proceed to mutation-chronology check. */ }
                    const laterMutationCompleted = durableMessages.slice(index + 1).some(later => {
                        if (later.type !== 'tool'
                            || later.toolStatus !== 'completed'
                            || later.toolExecuted !== true
                            || later.toolResult === undefined
                            || later.isError === true
                            || isToolResultError(later.toolResult)
                            || typeof later.toolName !== 'string')
                            return false;
                        const laterInput = later.toolInput
                            && typeof later.toolInput === 'object'
                            && !Array.isArray(later.toolInput)
                            ? later.toolInput
                            : {};
                        const { [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: _laterTerminalCapability, ...laterOperationalInput } = laterInput;
                        return !priorReceiptIsRead(later.toolName, laterOperationalInput);
                    });
                    if (laterMutationCompleted)
                        return false;
                }
                const priorCanonicalInput = priorInput
                    ? canonicalTerminalReconciliationToolInput(priorOperationalInput)
                    : undefined;
                return requestedCanonicalInput !== undefined && priorCanonicalInput === requestedCanonicalInput
                    || message.toolName === request.toolName
                        && (requestedCanonicalInput === undefined || priorCanonicalInput === undefined);
            });
            if (completedMatchingMutation) {
                throw new ToolAdmissionRecoveryError('Automatic recovery exactly-once fence: an equivalent durable tool receipt already completed this canonical mutation. Reuse its persisted result or reconcile state read-only; do not repeat the operation or request permission.');
            }
        }
    }
}


