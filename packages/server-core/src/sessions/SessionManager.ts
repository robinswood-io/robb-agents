import type { ISessionManager } from '@craft-agent/server-core/handlers';
import { SessionRuntimeState } from './SessionManager/runtime-state.ts';
import * as operations from './SessionManager/operations.ts';
import type { SessionOperationArguments, SessionOperationResult } from './SessionManager/operation-types.ts';

export class SessionManager implements ISessionManager {
  private readonly runtimeState = new SessionRuntimeState();

  private setProcessing(...args: SessionOperationArguments<'setProcessing'>): SessionOperationResult<'setProcessing'> {
    return operations.setProcessing({ owner: this, state: this.runtimeState }, ...args);
  }
  private emitExecutionTelemetry(...args: SessionOperationArguments<'emitExecutionTelemetry'>): SessionOperationResult<'emitExecutionTelemetry'> {
    return operations.emitExecutionTelemetry({ owner: this, state: this.runtimeState }, ...args);
  }
  private startGenerationTelemetry(...args: SessionOperationArguments<'startGenerationTelemetry'>): SessionOperationResult<'startGenerationTelemetry'> {
    return operations.startGenerationTelemetry({ owner: this, state: this.runtimeState }, ...args);
  }
  private finishGenerationTelemetry(...args: SessionOperationArguments<'finishGenerationTelemetry'>): SessionOperationResult<'finishGenerationTelemetry'> {
    return operations.finishGenerationTelemetry({ owner: this, state: this.runtimeState }, ...args);
  }
  private finishAllGenerationTelemetry(...args: SessionOperationArguments<'finishAllGenerationTelemetry'>): SessionOperationResult<'finishAllGenerationTelemetry'> {
    return operations.finishAllGenerationTelemetry({ owner: this, state: this.runtimeState }, ...args);
  }
  waitForInit(...args: SessionOperationArguments<'waitForInit'>): SessionOperationResult<'waitForInit'> {
    return operations.waitForInit({ owner: this, state: this.runtimeState }, ...args);
  }
  setAutomationBinder(...args: SessionOperationArguments<'setAutomationBinder'>): SessionOperationResult<'setAutomationBinder'> {
    return operations.setAutomationBinder({ owner: this, state: this.runtimeState }, ...args);
  }
  setEventSink(...args: SessionOperationArguments<'setEventSink'>): SessionOperationResult<'setEventSink'> {
    return operations.setEventSink({ owner: this, state: this.runtimeState }, ...args);
  }
  setBrowserPaneManager(...args: SessionOperationArguments<'setBrowserPaneManager'>): SessionOperationResult<'setBrowserPaneManager'> {
    return operations.setBrowserPaneManager({ owner: this, state: this.runtimeState }, ...args);
  }
  setRpcServer(...args: SessionOperationArguments<'setRpcServer'>): SessionOperationResult<'setRpcServer'> {
    return operations.setRpcServer({ owner: this, state: this.runtimeState }, ...args);
  }
  getBrowserPaneManagerForSession(...args: SessionOperationArguments<'getBrowserPaneManagerForSession'>): SessionOperationResult<'getBrowserPaneManagerForSession'> {
    return operations.getBrowserPaneManagerForSession({ owner: this, state: this.runtimeState }, ...args);
  }
  onClientDisconnected(...args: SessionOperationArguments<'onClientDisconnected'>): SessionOperationResult<'onClientDisconnected'> {
    return operations.onClientDisconnected({ owner: this, state: this.runtimeState }, ...args);
  }
  private closePendingPermissionRequestsForStop(...args: SessionOperationArguments<'closePendingPermissionRequestsForStop'>): SessionOperationResult<'closePendingPermissionRequestsForStop'> {
    return operations.closePendingPermissionRequestsForStop({ owner: this, state: this.runtimeState }, ...args);
  }
  setupConfigWatcher(...args: SessionOperationArguments<'setupConfigWatcher'>): SessionOperationResult<'setupConfigWatcher'> {
    return operations.setupConfigWatcher({ owner: this, state: this.runtimeState }, ...args);
  }
  notifyConfigFileChange(...args: SessionOperationArguments<'notifyConfigFileChange'>): SessionOperationResult<'notifyConfigFileChange'> {
    return operations.notifyConfigFileChange({ owner: this, state: this.runtimeState }, ...args);
  }
  private buildSessionSourceServers(...args: SessionOperationArguments<'buildSessionSourceServers'>): SessionOperationResult<'buildSessionSourceServers'> {
    return operations.buildSessionSourceServers({ owner: this, state: this.runtimeState }, ...args);
  }
  reinitializeAuth(...args: SessionOperationArguments<'reinitializeAuth'>): SessionOperationResult<'reinitializeAuth'> {
    return operations.reinitializeAuth({ owner: this, state: this.runtimeState }, ...args);
  }
  initialize(...args: SessionOperationArguments<'initialize'>): SessionOperationResult<'initialize'> {
    return operations.initialize({ owner: this, state: this.runtimeState }, ...args);
  }
  private hasPendingUserInput(...args: SessionOperationArguments<'hasPendingUserInput'>): SessionOperationResult<'hasPendingUserInput'> {
    return operations.hasPendingUserInput({ owner: this, state: this.runtimeState }, ...args);
  }
  private cancelPendingUserInput(...args: SessionOperationArguments<'cancelPendingUserInput'>): SessionOperationResult<'cancelPendingUserInput'> {
    return operations.cancelPendingUserInput({ owner: this, state: this.runtimeState }, ...args);
  }
  requestUserInput(...args: SessionOperationArguments<'requestUserInput'>): SessionOperationResult<'requestUserInput'> {
    return operations.requestUserInput({ owner: this, state: this.runtimeState }, ...args);
  }
  respondToUserInput(...args: SessionOperationArguments<'respondToUserInput'>): SessionOperationResult<'respondToUserInput'> {
    return operations.respondToUserInput({ owner: this, state: this.runtimeState }, ...args);
  }
  private clearPendingTurnRecovery(...args: SessionOperationArguments<'clearPendingTurnRecovery'>): SessionOperationResult<'clearPendingTurnRecovery'> {
    return operations.clearPendingTurnRecovery({ owner: this, state: this.runtimeState }, ...args);
  }
  private createAutonomousContextLimitHandoff(...args: SessionOperationArguments<'createAutonomousContextLimitHandoff'>): SessionOperationResult<'createAutonomousContextLimitHandoff'> {
    return operations.createAutonomousContextLimitHandoff({ owner: this, state: this.runtimeState }, ...args);
  }
  retryTurn(...args: SessionOperationArguments<'retryTurn'>): SessionOperationResult<'retryTurn'> {
    return operations.retryTurn({ owner: this, state: this.runtimeState }, ...args);
  }
  private retryTurnInternal(...args: SessionOperationArguments<'retryTurnInternal'>): SessionOperationResult<'retryTurnInternal'> {
    return operations.retryTurnInternal({ owner: this, state: this.runtimeState }, ...args);
  }
  private enqueueAutomaticTurnRecovery(...args: SessionOperationArguments<'enqueueAutomaticTurnRecovery'>): SessionOperationResult<'enqueueAutomaticTurnRecovery'> {
    return operations.enqueueAutomaticTurnRecovery({ owner: this, state: this.runtimeState }, ...args);
  }
  private resumePendingTurnAfterRestart(...args: SessionOperationArguments<'resumePendingTurnAfterRestart'>): SessionOperationResult<'resumePendingTurnAfterRestart'> {
    return operations.resumePendingTurnAfterRestart({ owner: this, state: this.runtimeState }, ...args);
  }
  private resumePendingTurnsAfterRestart(...args: SessionOperationArguments<'resumePendingTurnsAfterRestart'>): SessionOperationResult<'resumePendingTurnsAfterRestart'> {
    return operations.resumePendingTurnsAfterRestart({ owner: this, state: this.runtimeState }, ...args);
  }
  private scheduleDeferredAutomaticRetry(...args: SessionOperationArguments<'scheduleDeferredAutomaticRetry'>): SessionOperationResult<'scheduleDeferredAutomaticRetry'> {
    return operations.scheduleDeferredAutomaticRetry({ owner: this, state: this.runtimeState }, ...args);
  }
  private reconcileRecoveredTerminalStatus(...args: SessionOperationArguments<'reconcileRecoveredTerminalStatus'>): SessionOperationResult<'reconcileRecoveredTerminalStatus'> {
    return operations.reconcileRecoveredTerminalStatus({ owner: this, state: this.runtimeState }, ...args);
  }
  private claimAutomaticAdmission(...args: SessionOperationArguments<'claimAutomaticAdmission'>): SessionOperationResult<'claimAutomaticAdmission'> {
    return operations.claimAutomaticAdmission({ owner: this, state: this.runtimeState }, ...args);
  }
  private scheduleDeferredAutomaticSessions(...args: SessionOperationArguments<'scheduleDeferredAutomaticSessions'>): SessionOperationResult<'scheduleDeferredAutomaticSessions'> {
    return operations.scheduleDeferredAutomaticSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  private setMetadataWriteGuard(...args: SessionOperationArguments<'setMetadataWriteGuard'>): SessionOperationResult<'setMetadataWriteGuard'> {
    return operations.setMetadataWriteGuard({ owner: this, state: this.runtimeState }, ...args);
  }
  private persistSession(...args: SessionOperationArguments<'persistSession'>): SessionOperationResult<'persistSession'> {
    return operations.persistSession({ owner: this, state: this.runtimeState }, ...args);
  }
  private emitObjectiveChanged(...args: SessionOperationArguments<'emitObjectiveChanged'>): SessionOperationResult<'emitObjectiveChanged'> {
    return operations.emitObjectiveChanged({ owner: this, state: this.runtimeState }, ...args);
  }
  private reconcileRetainedTerminalMachineInbox(...args: SessionOperationArguments<'reconcileRetainedTerminalMachineInbox'>): SessionOperationResult<'reconcileRetainedTerminalMachineInbox'> {
    return operations.reconcileRetainedTerminalMachineInbox({ owner: this, state: this.runtimeState }, ...args);
  }
  private enqueuePersist(...args: SessionOperationArguments<'enqueuePersist'>): SessionOperationResult<'enqueuePersist'> {
    return operations.enqueuePersist({ owner: this, state: this.runtimeState }, ...args);
  }
  flushSession(...args: SessionOperationArguments<'flushSession'>): SessionOperationResult<'flushSession'> {
    return operations.flushSession({ owner: this, state: this.runtimeState }, ...args);
  }
  flushSessionDurably(...args: SessionOperationArguments<'flushSessionDurably'>): SessionOperationResult<'flushSessionDurably'> {
    return operations.flushSessionDurably({ owner: this, state: this.runtimeState }, ...args);
  }
  flushAllSessions(...args: SessionOperationArguments<'flushAllSessions'>): SessionOperationResult<'flushAllSessions'> {
    return operations.flushAllSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  private sendAuthenticatedInternalContinuation(...args: SessionOperationArguments<'sendAuthenticatedInternalContinuation'>): SessionOperationResult<'sendAuthenticatedInternalContinuation'> {
    return operations.sendAuthenticatedInternalContinuation({ owner: this, state: this.runtimeState }, ...args);
  }
  isPendingOAuthRequest(...args: SessionOperationArguments<'isPendingOAuthRequest'>): SessionOperationResult<'isPendingOAuthRequest'> {
    return operations.isPendingOAuthRequest({ owner: this, state: this.runtimeState }, ...args);
  }
  claimPendingOAuthRequest(...args: SessionOperationArguments<'claimPendingOAuthRequest'>): SessionOperationResult<'claimPendingOAuthRequest'> {
    return operations.claimPendingOAuthRequest({ owner: this, state: this.runtimeState }, ...args);
  }
  releasePendingOAuthRequest(...args: SessionOperationArguments<'releasePendingOAuthRequest'>): SessionOperationResult<'releasePendingOAuthRequest'> {
    return operations.releasePendingOAuthRequest({ owner: this, state: this.runtimeState }, ...args);
  }
  completeAuthRequest(...args: SessionOperationArguments<'completeAuthRequest'>): SessionOperationResult<'completeAuthRequest'> {
    return operations.completeAuthRequest({ owner: this, state: this.runtimeState }, ...args);
  }
  handleCredentialInput(...args: SessionOperationArguments<'handleCredentialInput'>): SessionOperationResult<'handleCredentialInput'> {
    return operations.handleCredentialInput({ owner: this, state: this.runtimeState }, ...args);
  }
  getWorkspaces(...args: SessionOperationArguments<'getWorkspaces'>): SessionOperationResult<'getWorkspaces'> {
    return operations.getWorkspaces({ owner: this, state: this.runtimeState }, ...args);
  }
  getWorkspacesInfo(...args: SessionOperationArguments<'getWorkspacesInfo'>): SessionOperationResult<'getWorkspacesInfo'> {
    return operations.getWorkspacesInfo({ owner: this, state: this.runtimeState }, ...args);
  }
  getActiveSessionCount(...args: SessionOperationArguments<'getActiveSessionCount'>): SessionOperationResult<'getActiveSessionCount'> {
    return operations.getActiveSessionCount({ owner: this, state: this.runtimeState }, ...args);
  }
  getWorkspaceAutomationSummary(...args: SessionOperationArguments<'getWorkspaceAutomationSummary'>): SessionOperationResult<'getWorkspaceAutomationSummary'> {
    return operations.getWorkspaceAutomationSummary({ owner: this, state: this.runtimeState }, ...args);
  }
  getActiveSessionsInfo(...args: SessionOperationArguments<'getActiveSessionsInfo'>): SessionOperationResult<'getActiveSessionsInfo'> {
    return operations.getActiveSessionsInfo({ owner: this, state: this.runtimeState }, ...args);
  }
  reloadSessions(...args: SessionOperationArguments<'reloadSessions'>): SessionOperationResult<'reloadSessions'> {
    return operations.reloadSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessions(...args: SessionOperationArguments<'getSessions'>): SessionOperationResult<'getSessions'> {
    return operations.getSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionWorkspaceId(...args: SessionOperationArguments<'getSessionWorkspaceId'>): SessionOperationResult<'getSessionWorkspaceId'> {
    return operations.getSessionWorkspaceId({ owner: this, state: this.runtimeState }, ...args);
  }
  getUnreadSummary(...args: SessionOperationArguments<'getUnreadSummary'>): SessionOperationResult<'getUnreadSummary'> {
    return operations.getUnreadSummary({ owner: this, state: this.runtimeState }, ...args);
  }
  refreshBadge(...args: SessionOperationArguments<'refreshBadge'>): SessionOperationResult<'refreshBadge'> {
    return operations.refreshBadge({ owner: this, state: this.runtimeState }, ...args);
  }
  private emitUnreadSummaryChanged(...args: SessionOperationArguments<'emitUnreadSummaryChanged'>): SessionOperationResult<'emitUnreadSummaryChanged'> {
    return operations.emitUnreadSummaryChanged({ owner: this, state: this.runtimeState }, ...args);
  }
  getSession(...args: SessionOperationArguments<'getSession'>): SessionOperationResult<'getSession'> {
    return operations.getSession({ owner: this, state: this.runtimeState }, ...args);
  }
  claimAndResumePendingMissionTurn(...args: SessionOperationArguments<'claimAndResumePendingMissionTurn'>): SessionOperationResult<'claimAndResumePendingMissionTurn'> {
    return operations.claimAndResumePendingMissionTurn({ owner: this, state: this.runtimeState }, ...args);
  }
  resolveMissionEnabledSourceSlugs(...args: SessionOperationArguments<'resolveMissionEnabledSourceSlugs'>): SessionOperationResult<'resolveMissionEnabledSourceSlugs'> {
    return operations.resolveMissionEnabledSourceSlugs({ owner: this, state: this.runtimeState }, ...args);
  }
  preflightMissionToolInvocation(...args: SessionOperationArguments<'preflightMissionToolInvocation'>): SessionOperationResult<'preflightMissionToolInvocation'> {
    return operations.preflightMissionToolInvocation({ owner: this, state: this.runtimeState }, ...args);
  }
  preflightMissionToolInvocations(...args: SessionOperationArguments<'preflightMissionToolInvocations'>): SessionOperationResult<'preflightMissionToolInvocations'> {
    return operations.preflightMissionToolInvocations({ owner: this, state: this.runtimeState }, ...args);
  }
  bindSpecializedMissionCapabilityLock(...args: SessionOperationArguments<'bindSpecializedMissionCapabilityLock'>): SessionOperationResult<'bindSpecializedMissionCapabilityLock'> {
    return operations.bindSpecializedMissionCapabilityLock({ owner: this, state: this.runtimeState }, ...args);
  }
  private assertSpecializedMissionCapabilities(...args: SessionOperationArguments<'assertSpecializedMissionCapabilities'>): SessionOperationResult<'assertSpecializedMissionCapabilities'> {
    return operations.assertSpecializedMissionCapabilities({ owner: this, state: this.runtimeState }, ...args);
  }
  private ensureMessagesLoaded(...args: SessionOperationArguments<'ensureMessagesLoaded'>): SessionOperationResult<'ensureMessagesLoaded'> {
    return operations.ensureMessagesLoaded({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionPath(...args: SessionOperationArguments<'getSessionPath'>): SessionOperationResult<'getSessionPath'> {
    return operations.getSessionPath({ owner: this, state: this.runtimeState }, ...args);
  }
  createSession(...args: SessionOperationArguments<'createSession'>): SessionOperationResult<'createSession'> {
    return operations.createSession({ owner: this, state: this.runtimeState }, ...args);
  }
  private performCreateSession(...args: SessionOperationArguments<'performCreateSession'>): SessionOperationResult<'performCreateSession'> {
    return operations.performCreateSession({ owner: this, state: this.runtimeState }, ...args);
  }
  notifySessionCreated(...args: SessionOperationArguments<'notifySessionCreated'>): SessionOperationResult<'notifySessionCreated'> {
    return operations.notifySessionCreated({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionWorkingDirectory(...args: SessionOperationArguments<'getSessionWorkingDirectory'>): SessionOperationResult<'getSessionWorkingDirectory'> {
    return operations.getSessionWorkingDirectory({ owner: this, state: this.runtimeState }, ...args);
  }
  listTaskReviewerSessions(...args: SessionOperationArguments<'listTaskReviewerSessions'>): SessionOperationResult<'listTaskReviewerSessions'> {
    return operations.listTaskReviewerSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  listTaskWorkerSessions(...args: SessionOperationArguments<'listTaskWorkerSessions'>): SessionOperationResult<'listTaskWorkerSessions'> {
    return operations.listTaskWorkerSessions({ owner: this, state: this.runtimeState }, ...args);
  }
  cancelProcessingAndWait(...args: SessionOperationArguments<'cancelProcessingAndWait'>): SessionOperationResult<'cancelProcessingAndWait'> {
    return operations.cancelProcessingAndWait({ owner: this, state: this.runtimeState }, ...args);
  }
  private performCancelProcessingAndWait(...args: SessionOperationArguments<'performCancelProcessingAndWait'>): SessionOperationResult<'performCancelProcessingAndWait'> {
    return operations.performCancelProcessingAndWait({ owner: this, state: this.runtimeState }, ...args);
  }
  private disposeManagedAgentRuntime(...args: SessionOperationArguments<'disposeManagedAgentRuntime'>): SessionOperationResult<'disposeManagedAgentRuntime'> {
    return operations.disposeManagedAgentRuntime({ owner: this, state: this.runtimeState }, ...args);
  }
  private tryRefreshAgentRuntime(...args: SessionOperationArguments<'tryRefreshAgentRuntime'>): SessionOperationResult<'tryRefreshAgentRuntime'> {
    return operations.tryRefreshAgentRuntime({ owner: this, state: this.runtimeState }, ...args);
  }
  refreshConnectionRuntime(...args: SessionOperationArguments<'refreshConnectionRuntime'>): SessionOperationResult<'refreshConnectionRuntime'> {
    return operations.refreshConnectionRuntime({ owner: this, state: this.runtimeState }, ...args);
  }
  private applyExternalActionPolicyToRuntime(...args: SessionOperationArguments<'applyExternalActionPolicyToRuntime'>): SessionOperationResult<'applyExternalActionPolicyToRuntime'> {
    return operations.applyExternalActionPolicyToRuntime({ owner: this, state: this.runtimeState }, ...args);
  }
  refreshWorkspaceExternalActionPolicy(...args: SessionOperationArguments<'refreshWorkspaceExternalActionPolicy'>): SessionOperationResult<'refreshWorkspaceExternalActionPolicy'> {
    return operations.refreshWorkspaceExternalActionPolicy({ owner: this, state: this.runtimeState }, ...args);
  }
  restartAgentRuntime(...args: SessionOperationArguments<'restartAgentRuntime'>): SessionOperationResult<'restartAgentRuntime'> {
    return operations.restartAgentRuntime({ owner: this, state: this.runtimeState }, ...args);
  }
  private loadAgentContextWindowPreference(...args: SessionOperationArguments<'loadAgentContextWindowPreference'>): SessionOperationResult<'loadAgentContextWindowPreference'> {
    return operations.loadAgentContextWindowPreference({ owner: this, state: this.runtimeState }, ...args);
  }
  private getOrCreateAgent(...args: SessionOperationArguments<'getOrCreateAgent'>): SessionOperationResult<'getOrCreateAgent'> {
    return operations.getOrCreateAgent({ owner: this, state: this.runtimeState }, ...args);
  }
  flagSession(...args: SessionOperationArguments<'flagSession'>): SessionOperationResult<'flagSession'> {
    return operations.flagSession({ owner: this, state: this.runtimeState }, ...args);
  }
  unflagSession(...args: SessionOperationArguments<'unflagSession'>): SessionOperationResult<'unflagSession'> {
    return operations.unflagSession({ owner: this, state: this.runtimeState }, ...args);
  }
  archiveSession(...args: SessionOperationArguments<'archiveSession'>): SessionOperationResult<'archiveSession'> {
    return operations.archiveSession({ owner: this, state: this.runtimeState }, ...args);
  }
  unarchiveSession(...args: SessionOperationArguments<'unarchiveSession'>): SessionOperationResult<'unarchiveSession'> {
    return operations.unarchiveSession({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionStatus(...args: SessionOperationArguments<'setSessionStatus'>): SessionOperationResult<'setSessionStatus'> {
    return operations.setSessionStatus({ owner: this, state: this.runtimeState }, ...args);
  }
  private beginAutomaticSessionStatusLifecycle(...args: SessionOperationArguments<'beginAutomaticSessionStatusLifecycle'>): SessionOperationResult<'beginAutomaticSessionStatusLifecycle'> {
    return operations.beginAutomaticSessionStatusLifecycle({ owner: this, state: this.runtimeState }, ...args);
  }
  private finishAutomaticSessionStatusLifecycle(...args: SessionOperationArguments<'finishAutomaticSessionStatusLifecycle'>): SessionOperationResult<'finishAutomaticSessionStatusLifecycle'> {
    return operations.finishAutomaticSessionStatusLifecycle({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionConnection(...args: SessionOperationArguments<'setSessionConnection'>): SessionOperationResult<'setSessionConnection'> {
    return operations.setSessionConnection({ owner: this, state: this.runtimeState }, ...args);
  }
  setPendingPlanExecution(...args: SessionOperationArguments<'setPendingPlanExecution'>): SessionOperationResult<'setPendingPlanExecution'> {
    return operations.setPendingPlanExecution({ owner: this, state: this.runtimeState }, ...args);
  }
  markCompactionComplete(...args: SessionOperationArguments<'markCompactionComplete'>): SessionOperationResult<'markCompactionComplete'> {
    return operations.markCompactionComplete({ owner: this, state: this.runtimeState }, ...args);
  }
  markPendingPlanExecutionDispatched(...args: SessionOperationArguments<'markPendingPlanExecutionDispatched'>): SessionOperationResult<'markPendingPlanExecutionDispatched'> {
    return operations.markPendingPlanExecutionDispatched({ owner: this, state: this.runtimeState }, ...args);
  }
  clearPendingPlanExecution(...args: SessionOperationArguments<'clearPendingPlanExecution'>): SessionOperationResult<'clearPendingPlanExecution'> {
    return operations.clearPendingPlanExecution({ owner: this, state: this.runtimeState }, ...args);
  }
  getPendingPlanExecution(...args: SessionOperationArguments<'getPendingPlanExecution'>): SessionOperationResult<'getPendingPlanExecution'> {
    return operations.getPendingPlanExecution({ owner: this, state: this.runtimeState }, ...args);
  }
  acceptPlan(...args: SessionOperationArguments<'acceptPlan'>): SessionOperationResult<'acceptPlan'> {
    return operations.acceptPlan({ owner: this, state: this.runtimeState }, ...args);
  }
  shareToViewer(...args: SessionOperationArguments<'shareToViewer'>): SessionOperationResult<'shareToViewer'> {
    return operations.shareToViewer({ owner: this, state: this.runtimeState }, ...args);
  }
  updateShare(...args: SessionOperationArguments<'updateShare'>): SessionOperationResult<'updateShare'> {
    return operations.updateShare({ owner: this, state: this.runtimeState }, ...args);
  }
  revokeShare(...args: SessionOperationArguments<'revokeShare'>): SessionOperationResult<'revokeShare'> {
    return operations.revokeShare({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionSources(...args: SessionOperationArguments<'setSessionSources'>): SessionOperationResult<'setSessionSources'> {
    return operations.setSessionSources({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionSources(...args: SessionOperationArguments<'getSessionSources'>): SessionOperationResult<'getSessionSources'> {
    return operations.getSessionSources({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionFinalText(...args: SessionOperationArguments<'getSessionFinalText'>): SessionOperationResult<'getSessionFinalText'> {
    return operations.getSessionFinalText({ owner: this, state: this.runtimeState }, ...args);
  }
  setActiveViewingSession(...args: SessionOperationArguments<'setActiveViewingSession'>): SessionOperationResult<'setActiveViewingSession'> {
    return operations.setActiveViewingSession({ owner: this, state: this.runtimeState }, ...args);
  }
  clearActiveViewingSession(...args: SessionOperationArguments<'clearActiveViewingSession'>): SessionOperationResult<'clearActiveViewingSession'> {
    return operations.clearActiveViewingSession({ owner: this, state: this.runtimeState }, ...args);
  }
  private isSessionBeingViewed(...args: SessionOperationArguments<'isSessionBeingViewed'>): SessionOperationResult<'isSessionBeingViewed'> {
    return operations.isSessionBeingViewed({ owner: this, state: this.runtimeState }, ...args);
  }
  markSessionRead(...args: SessionOperationArguments<'markSessionRead'>): SessionOperationResult<'markSessionRead'> {
    return operations.markSessionRead({ owner: this, state: this.runtimeState }, ...args);
  }
  markSessionUnread(...args: SessionOperationArguments<'markSessionUnread'>): SessionOperationResult<'markSessionUnread'> {
    return operations.markSessionUnread({ owner: this, state: this.runtimeState }, ...args);
  }
  markAllSessionsRead(...args: SessionOperationArguments<'markAllSessionsRead'>): SessionOperationResult<'markAllSessionsRead'> {
    return operations.markAllSessionsRead({ owner: this, state: this.runtimeState }, ...args);
  }
  renameSession(...args: SessionOperationArguments<'renameSession'>): SessionOperationResult<'renameSession'> {
    return operations.renameSession({ owner: this, state: this.runtimeState }, ...args);
  }
  refreshTitle(...args: SessionOperationArguments<'refreshTitle'>): SessionOperationResult<'refreshTitle'> {
    return operations.refreshTitle({ owner: this, state: this.runtimeState }, ...args);
  }
  updateWorkingDirectory(...args: SessionOperationArguments<'updateWorkingDirectory'>): SessionOperationResult<'updateWorkingDirectory'> {
    return operations.updateWorkingDirectory({ owner: this, state: this.runtimeState }, ...args);
  }
  updateSessionModel(...args: SessionOperationArguments<'updateSessionModel'>): SessionOperationResult<'updateSessionModel'> {
    return operations.updateSessionModel({ owner: this, state: this.runtimeState }, ...args);
  }
  private performUpdateSessionModel(...args: SessionOperationArguments<'performUpdateSessionModel'>): SessionOperationResult<'performUpdateSessionModel'> {
    return operations.performUpdateSessionModel({ owner: this, state: this.runtimeState }, ...args);
  }
  updateMessageContent(...args: SessionOperationArguments<'updateMessageContent'>): SessionOperationResult<'updateMessageContent'> {
    return operations.updateMessageContent({ owner: this, state: this.runtimeState }, ...args);
  }
  addMessageAnnotation(...args: SessionOperationArguments<'addMessageAnnotation'>): SessionOperationResult<'addMessageAnnotation'> {
    return operations.addMessageAnnotation({ owner: this, state: this.runtimeState }, ...args);
  }
  updateMessageAnnotation(...args: SessionOperationArguments<'updateMessageAnnotation'>): SessionOperationResult<'updateMessageAnnotation'> {
    return operations.updateMessageAnnotation({ owner: this, state: this.runtimeState }, ...args);
  }
  removeMessageAnnotation(...args: SessionOperationArguments<'removeMessageAnnotation'>): SessionOperationResult<'removeMessageAnnotation'> {
    return operations.removeMessageAnnotation({ owner: this, state: this.runtimeState }, ...args);
  }
  deleteSession(...args: SessionOperationArguments<'deleteSession'>): SessionOperationResult<'deleteSession'> {
    return operations.deleteSession({ owner: this, state: this.runtimeState }, ...args);
  }
  sendMessage(...args: SessionOperationArguments<'sendMessage'>): SessionOperationResult<'sendMessage'> {
    return operations.sendMessage({ owner: this, state: this.runtimeState }, ...args);
  }
  private performSendMessage(...args: SessionOperationArguments<'performSendMessage'>): SessionOperationResult<'performSendMessage'> {
    return operations.performSendMessage({ owner: this, state: this.runtimeState }, ...args);
  }
  cancelProcessing(...args: SessionOperationArguments<'cancelProcessing'>): SessionOperationResult<'cancelProcessing'> {
    return operations.cancelProcessing({ owner: this, state: this.runtimeState }, ...args);
  }
  onSessionComplete(...args: SessionOperationArguments<'onSessionComplete'>): SessionOperationResult<'onSessionComplete'> {
    return operations.onSessionComplete({ owner: this, state: this.runtimeState }, ...args);
  }
  recordExecutionProof(...args: SessionOperationArguments<'recordExecutionProof'>): SessionOperationResult<'recordExecutionProof'> {
    return operations.recordExecutionProof({ owner: this, state: this.runtimeState }, ...args);
  }
  private emitSessionComplete(...args: SessionOperationArguments<'emitSessionComplete'>): SessionOperationResult<'emitSessionComplete'> {
    return operations.emitSessionComplete({ owner: this, state: this.runtimeState }, ...args);
  }
  private onProcessingStopped(...args: SessionOperationArguments<'onProcessingStopped'>): SessionOperationResult<'onProcessingStopped'> {
    return operations.onProcessingStopped({ owner: this, state: this.runtimeState }, ...args);
  }
  private processNextQueuedMessage(...args: SessionOperationArguments<'processNextQueuedMessage'>): SessionOperationResult<'processNextQueuedMessage'> {
    return operations.processNextQueuedMessage({ owner: this, state: this.runtimeState }, ...args);
  }
  killShell(...args: SessionOperationArguments<'killShell'>): SessionOperationResult<'killShell'> {
    return operations.killShell({ owner: this, state: this.runtimeState }, ...args);
  }
  private markOrphanedBackgroundTasks(...args: SessionOperationArguments<'markOrphanedBackgroundTasks'>): SessionOperationResult<'markOrphanedBackgroundTasks'> {
    return operations.markOrphanedBackgroundTasks({ owner: this, state: this.runtimeState }, ...args);
  }
  listBackgroundTasks(...args: SessionOperationArguments<'listBackgroundTasks'>): SessionOperationResult<'listBackgroundTasks'> {
    return operations.listBackgroundTasks({ owner: this, state: this.runtimeState }, ...args);
  }
  getTaskSessionId(...args: SessionOperationArguments<'getTaskSessionId'>): SessionOperationResult<'getTaskSessionId'> {
    return operations.getTaskSessionId({ owner: this, state: this.runtimeState }, ...args);
  }
  getTaskOutput(...args: SessionOperationArguments<'getTaskOutput'>): SessionOperationResult<'getTaskOutput'> {
    return operations.getTaskOutput({ owner: this, state: this.runtimeState }, ...args);
  }
  respondToPermission(...args: SessionOperationArguments<'respondToPermission'>): SessionOperationResult<'respondToPermission'> {
    return operations.respondToPermission({ owner: this, state: this.runtimeState }, ...args);
  }
  respondToCredential(...args: SessionOperationArguments<'respondToCredential'>): SessionOperationResult<'respondToCredential'> {
    return operations.respondToCredential({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionPermissionMode(...args: SessionOperationArguments<'setSessionPermissionMode'>): SessionOperationResult<'setSessionPermissionMode'> {
    return operations.setSessionPermissionMode({ owner: this, state: this.runtimeState }, ...args);
  }
  getSessionPermissionModeState(...args: SessionOperationArguments<'getSessionPermissionModeState'>): SessionOperationResult<'getSessionPermissionModeState'> {
    return operations.getSessionPermissionModeState({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionLabels(...args: SessionOperationArguments<'setSessionLabels'>): SessionOperationResult<'setSessionLabels'> {
    return operations.setSessionLabels({ owner: this, state: this.runtimeState }, ...args);
  }
  applyTaskLabel(...args: SessionOperationArguments<'applyTaskLabel'>): SessionOperationResult<'applyTaskLabel'> {
    return operations.applyTaskLabel({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionProjectId(...args: SessionOperationArguments<'setSessionProjectId'>): SessionOperationResult<'setSessionProjectId'> {
    return operations.setSessionProjectId({ owner: this, state: this.runtimeState }, ...args);
  }
  setKanbanColumn(...args: SessionOperationArguments<'setKanbanColumn'>): SessionOperationResult<'setKanbanColumn'> {
    return operations.setKanbanColumn({ owner: this, state: this.runtimeState }, ...args);
  }
  setTaskNodeCount(...args: SessionOperationArguments<'setTaskNodeCount'>): SessionOperationResult<'setTaskNodeCount'> {
    return operations.setTaskNodeCount({ owner: this, state: this.runtimeState }, ...args);
  }
  adoptGeneratedTaskOrchestrator(...args: SessionOperationArguments<'adoptGeneratedTaskOrchestrator'>): SessionOperationResult<'adoptGeneratedTaskOrchestrator'> {
    return operations.adoptGeneratedTaskOrchestrator({ owner: this, state: this.runtimeState }, ...args);
  }
  bindExistingSessionToTask(...args: SessionOperationArguments<'bindExistingSessionToTask'>): SessionOperationResult<'bindExistingSessionToTask'> {
    return operations.bindExistingSessionToTask({ owner: this, state: this.runtimeState }, ...args);
  }
  setSessionThinkingLevel(...args: SessionOperationArguments<'setSessionThinkingLevel'>): SessionOperationResult<'setSessionThinkingLevel'> {
    return operations.setSessionThinkingLevel({ owner: this, state: this.runtimeState }, ...args);
  }
  private durablyRecordAutomaticRecoveryToolAdmission(...args: SessionOperationArguments<'durablyRecordAutomaticRecoveryToolAdmission'>): SessionOperationResult<'durablyRecordAutomaticRecoveryToolAdmission'> {
    return operations.durablyRecordAutomaticRecoveryToolAdmission({ owner: this, state: this.runtimeState }, ...args);
  }
  private sendEvent(...args: SessionOperationArguments<'sendEvent'>): SessionOperationResult<'sendEvent'> {
    return operations.sendEvent({ owner: this, state: this.runtimeState }, ...args);
  }
  executePromptAutomation(...args: SessionOperationArguments<'executePromptAutomation'>): SessionOperationResult<'executePromptAutomation'> {
    return operations.executePromptAutomation({ owner: this, state: this.runtimeState }, ...args);
  }
  exportRemoteSessionTransfer(...args: SessionOperationArguments<'exportRemoteSessionTransfer'>): SessionOperationResult<'exportRemoteSessionTransfer'> {
    return operations.exportRemoteSessionTransfer({ owner: this, state: this.runtimeState }, ...args);
  }
  importRemoteSessionTransfer(...args: SessionOperationArguments<'importRemoteSessionTransfer'>): SessionOperationResult<'importRemoteSessionTransfer'> {
    return operations.importRemoteSessionTransfer({ owner: this, state: this.runtimeState }, ...args);
  }
  exportSession(...args: SessionOperationArguments<'exportSession'>): SessionOperationResult<'exportSession'> {
    return operations.exportSession({ owner: this, state: this.runtimeState }, ...args);
  }
  importSession(...args: SessionOperationArguments<'importSession'>): SessionOperationResult<'importSession'> {
    return operations.importSession({ owner: this, state: this.runtimeState }, ...args);
  }
  cleanup(...args: SessionOperationArguments<'cleanup'>): SessionOperationResult<'cleanup'> {
    return operations.cleanup({ owner: this, state: this.runtimeState }, ...args);
  }
}

export { sanitizeForTitle } from "@craft-agent/server-core/domain";
export { setSessionPlatform, setSessionRuntimeHooks } from './SessionManager/runtime-platform.ts';
export { AGENT_FLAGS } from './SessionManager/runtime-policy.ts';
export { loadPiTurnAnchors, savePiTurnAnchor, copyPiTurnAnchorsForBranch } from './SessionManager/turn-anchors.ts';
export type { AutoRetryPendingHost, SourceActivationRestartHost } from './SessionManager/source-activation.ts';
export { commitRevocableSourceActivationRuntime, claimAutoRetryPending } from './SessionManager/source-activation.ts';
export type { SessionCompletionEvent, MissionPendingTurnRecoveryClaim, MissionPendingTurnRecoveryClaimDecision, } from './SessionManager/runtime-types.ts';
export type { SessionReviewRole } from './SessionManager/review-lifecycle.ts';
export { isTerminalReviewSession, isMissionRuntimeOwnedRecovery, delegatedObjectiveRoleForSession, terminalReviewExecutionIsolation, } from './SessionManager/review-lifecycle.ts';
export { consumeSourceActivationRestart } from './SessionManager/user-input-authority.ts';
export type { SpawnRouteSelection } from './SessionManager/session-creation.ts';
export { resolveCreateSessionRouteProvenance, resolveSpawnedSessionRoute, resolveExplicitSpawnedSessionRoute, sanitizeParentSessionLabels, createManagedSession, } from './SessionManager/session-creation.ts';
export type { EffectiveSessionSourceSelection } from './SessionManager/source-selection.ts';
export { resolveEffectiveSessionSourceSelection, refreshInheritedSessionSourceSelection, sessionSourceSlugsForPersistence, resolveBranchedSessionSourceSelection, } from './SessionManager/source-selection.ts';
