import type { SessionManager } from '../SessionManager.ts';
import type { PiAgent } from '@craft-agent/shared/agent';

// Test access names each exercised private operation using its production signature.
// The public class and its encapsulation remain unchanged.
export type SessionManagerTestView = { [Key in keyof SessionManager]: SessionManager[Key] } & {
  activeRelevantDelegatedDescendants: SessionManager['activeRelevantDelegatedDescendants'];
  authenticatedObjectiveAuthorizationSegments: SessionManager['authenticatedObjectiveAuthorizationSegments'];
  beginAutomaticSessionStatusLifecycle: SessionManager['beginAutomaticSessionStatusLifecycle'];
  cancelPendingUserInput: SessionManager['cancelPendingUserInput'];
  buildRecoveryDispatchMessage: SessionManager['buildRecoveryDispatchMessage'];
  createAutonomousContextLimitHandoff: SessionManager['createAutonomousContextLimitHandoff'];
  createContextLimitRetryHandoff: SessionManager['createContextLimitRetryHandoff'];
  closePendingPermissionRequestsForStop: SessionManager['closePendingPermissionRequestsForStop'];
  deferTerminalOutcomeForActiveDelegations: SessionManager['deferTerminalOutcomeForActiveDelegations'];
  disposeManagedAgentRuntime: SessionManager['disposeManagedAgentRuntime'];
  drainDeferredAutomaticSessions: SessionManager['drainDeferredAutomaticSessions'];
  durablyRecordAutomaticRecoveryToolAdmission: SessionManager['durablyRecordAutomaticRecoveryToolAdmission'];
  emitExecutionTelemetry: SessionManager['emitExecutionTelemetry'];
  emitSessionComplete: SessionManager['emitSessionComplete'];
  enqueueAutomaticTurnRecovery: SessionManager['enqueueAutomaticTurnRecovery'];
  ensureDelegatedTerminalResultDelivery: SessionManager['ensureDelegatedTerminalResultDelivery'];
  ensureMessagesLoaded: SessionManager['ensureMessagesLoaded'];
  finishAllGenerationTelemetry: SessionManager['finishAllGenerationTelemetry'];
  finishGenerationTelemetry: SessionManager['finishGenerationTelemetry'];
  getInterruptedTurnRecovery: SessionManager['getInterruptedTurnRecovery'];
  getOrCreateAgent: SessionManager['getOrCreateAgent'];
  grantLiveDirectHumanContinuation: SessionManager['grantLiveDirectHumanContinuation'];
  hasConsumedCleanRecoveryDispatch: SessionManager['hasConsumedCleanRecoveryDispatch'];
  loadSessionsFromDisk: SessionManager['loadSessionsFromDisk'];
  onProcessingStopped: SessionManager['onProcessingStopped'];
  pendingRecoveryBelongsToCurrentObjective: SessionManager['pendingRecoveryBelongsToCurrentObjective'];
  persistRegisteredObjectiveForCurrentTurn: SessionManager['persistRegisteredObjectiveForCurrentTurn'];
  persistSession: SessionManager['persistSession'];
  processEvent: SessionManager['processEvent'];
  processNextQueuedMessage: SessionManager['processNextQueuedMessage'];
  providerDispatchAdmissionBarrier: SessionManager['providerDispatchAdmissionBarrier'];
  queuedHumanIndex: SessionManager['queuedHumanIndex'];
  reconcileProviderAcceptanceUnknownForRetry: SessionManager['reconcileProviderAcceptanceUnknownForRetry'];
  reconcileRetainedTerminalMachineInbox: SessionManager['reconcileRetainedTerminalMachineInbox'];
  reserveSpawnAdmission: SessionManager['reserveSpawnAdmission'];
  restoreDurableRuntimeState: SessionManager['restoreDurableRuntimeState'];
  resumeOrphanedContextAnswerAfterRestart: SessionManager['resumeOrphanedContextAnswerAfterRestart'];
  resumePendingTurnAfterRestart: SessionManager['resumePendingTurnAfterRestart'];
  resumePendingTurnsAfterRestart: SessionManager['resumePendingTurnsAfterRestart'];
  retryTurnInternal: SessionManager['retryTurnInternal'];
  retryableContextLimitRequest: SessionManager['retryableContextLimitRequest'];
  scheduleDeferredAutomaticRetry: SessionManager['scheduleDeferredAutomaticRetry'];
  scheduleDeferredAutomaticSessions: SessionManager['scheduleDeferredAutomaticSessions'];
  scheduleDelegatedTerminalResultRetry: SessionManager['scheduleDelegatedTerminalResultRetry'];
  sendAuthenticatedInternalContinuation: SessionManager['sendAuthenticatedInternalContinuation'];
  sendEvent: SessionManager['sendEvent'];
  setProcessing: SessionManager['setProcessing'];
  startGenerationTelemetry: SessionManager['startGenerationTelemetry'];
  trackManagedAgentRuntimeDisposal: SessionManager['trackManagedAgentRuntimeDisposal'];
};

export type PiAgentTestView = { [Key in keyof PiAgent]: PiAgent[Key] } & {
  beginAdmittedToolExecution: PiAgent['beginAdmittedToolExecution'];
  promptPreparationRevision: PiAgent['promptPreparationRevision'];
  send: PiAgent['send'];
  sendPreToolUseDecision: PiAgent['sendPreToolUseDecision'];
  subprocessRuntimeContext: PiAgent['subprocessRuntimeContext'];
};

export type SessionSendArguments = Parameters<SessionManager['sendMessage']>;
export type SessionSentEvent = Parameters<SessionManager['sendEvent']>[0];

export function sessionManagerForTest(manager: SessionManager): SessionManagerTestView {
  return manager as unknown as SessionManagerTestView;
}

export function piAgentForTest(agent: PiAgent): PiAgentTestView {
  return agent as unknown as PiAgentTestView;
}
