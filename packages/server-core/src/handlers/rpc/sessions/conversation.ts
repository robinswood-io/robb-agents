import { RPC_CHANNELS, type FileAttachment, type SendMessageOptions, type SessionEvent } from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';


import { isValidThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
import { assertRequestWorkspace, pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";


export function registerConversationHandlers(server: RpcServer, deps: HandlerDeps, sessionManager: HandlerDeps['sessionManager'], log: HandlerDeps['platform']['logger'], assertSessionAccess: (ctx: RequestContext, sessionId: string) => void, assertRpcSendMessageOptions: (options?: SendMessageOptions) => void, VALID_THINKING_LEVELS_LIST: string): void {

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Awaits until the user message is persisted to disk, then returns
  //     `{ accepted: true, messageId }`. This guarantees the message survives
  //     a mid-stream crash (#616).
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    await assertSessionAccess(ctx, sessionId)
    // Orchestration/recovery provenance is minted only by in-process host
    // flows. Accepting it from RPC would let a client impersonate a Task or
    // Mission dispatch and hide part of its text from safety routing.
    assertRpcSendMessageOptions(options)
    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId

    return await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
      let acked = false
      const onAck = (messageId: string) => {
        if (!acked) {
          acked = true
          resolve({ accepted: true, messageId })
        }
      }

      sessionManager
        .sendMessage(sessionId, message, attachments, storedAttachments, options, undefined, undefined, onAck, { callerClientId })
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            reject(new Error('sendMessage completed without persisting a user message'))
          }
        })
        .catch((err: unknown) => {
          log.error('Error in sendMessage:', err)
          if (!acked) {
            // Pre-persist error — surface synchronously to the caller.
            acked = true
            reject(err)
            return
          }
          // Post-persist error — route via the event stream as today.
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error'
          } as SessionEvent)
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'complete',
            sessionId,
            reason: 'error',
          } as SessionEvent)
        })
    })
  })

  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, async (ctx, sessionId: string, response: import('@craft-agent/core/types').UserInputResponse) => {
    // Authorize metadata before hydration can recover a queued answer.
    const session = sessionManager.getSessions().find(candidate => candidate.id === sessionId)
    if (!session) throw new Error('Question session not found')
    assertRequestWorkspace(ctx, session.workspaceId)
    return sessionManager.respondToUserInput(sessionId, response, { callerClientId: ctx.clientId })
  })

  // Cancel processing
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (ctx, sessionId: string, silent?: boolean) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.cancelProcessing(sessionId, silent)
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (ctx, sessionId: string, shellId: string) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.killShell(sessionId, shellId)
  })

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (ctx, taskId: string) => {
    try {
      const ownerSessionId = sessionManager.getTaskSessionId(taskId)
      if (!ownerSessionId) return null
      await assertSessionAccess(ctx, ownerSessionId)
      const output = await sessionManager.getTaskOutput(taskId)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (
    ctx,
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (ctx, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.respondToCredential(sessionId, requestId, response)
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    ctx,
    sessionId: string,
    command: import('@craft-agent/shared/protocol').SessionCommand
  ) => {
    if (command.type === 'retryTurn') {
      // Hydration can resume queued work. Authorize metadata first, as for
      // question responses, before the retry takes the session reservation.
      const session = sessionManager.getSessions().find(candidate => candidate.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      assertRequestWorkspace(ctx, session.workspaceId)
    } else {
      await assertSessionAccess(ctx, sessionId)
    }
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId)
      case 'archive':
        return sessionManager.archiveSession(sessionId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        assertRequestWorkspace(ctx, command.workspaceId)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode':
        return sessionManager.setSessionPermissionMode(sessionId, command.mode)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'updateWorkingDirectory':
        return sessionManager.updateWorkingDirectory(sessionId, command.dir)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels)
      case 'setProjectId':
        return sessionManager.setSessionProjectId(sessionId, command.projectId)
      case 'setKanbanColumn':
        return sessionManager.setKanbanColumn(sessionId, command.column)
      case 'showInFinder': {
        const sessionPath = sessionManager.getSessionPath(sessionId)
        if (sessionPath) {
          deps.platform.showItemInFolder?.(sessionPath)
        }
        return
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = sessionManager.getSessionPath(sessionId)
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId)
      case 'restartRuntime':
        log.info(`IPC: restartRuntime received for session ${sessionId}`)
        return sessionManager.restartAgentRuntime(sessionId)
      case 'retryTurn':
        return sessionManager.retryTurn(sessionId, command.userMessageId, { callerClientId: ctx.clientId })
      // Connection selection (locked after first message)
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, command.planPath, command.draftInputSnapshot)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch)
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown session command: ${JSON.stringify(_exhaustive)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    ctx,
    sessionId: string
  ) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.getPendingPlanExecution(sessionId)
  })

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    ctx,
    sessionId: string
  ) => {
    await assertSessionAccess(ctx, sessionId)
    return sessionManager.getSessionPermissionModeState(sessionId)
  })
}
