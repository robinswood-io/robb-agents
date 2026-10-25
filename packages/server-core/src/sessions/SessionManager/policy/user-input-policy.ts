import { type UserInputRequest } from "@craft-agent/core";
import { type SendMessageOptions } from "@craft-agent/shared/protocol";
import { type Message } from "@craft-agent/core/types";
import type { ManagedSession } from "../managed-session.ts";
import { canonicalUserInputAnswerContents, isCostLimitContinuationAnswer } from "../user-input-authority.ts";

/** An accepted structured answer becomes durable before its delivery calls
   * sendMessage. A simultaneous free-form continuation must not overtake that
   * answer during the small gap where it has no FIFO row yet. */
export function hasUnscheduledQueuedUserInput(managed: ManagedSession): boolean {
    return managed.messages.some(message => message.isQueued && message.internalOrigin?.kind === 'user-input'
      && !managed.messageQueue.some(item => item.messageId === message.id)
      && managed.userInputRequests?.some(request => request.status === 'answered'
        && request.responseMessageId === message.id && request.sessionId === managed.id
        && request.originWorkspaceId === managed.workspace.id))
  }

export function hasPendingLocalUserInput(managed: ManagedSession): boolean {
    return !!managed.userInputRequests?.some(request => request.status === 'pending'
      && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id)
  }

/** A terminal objective may be reopened by a saved answer only while the
   * exact host-authenticated answer is still waiting in the durable inbox.
   * An answered request alone cannot prove that its response was unconsumed. */
export function getQueuedPendingUserInputResponse(managed: ManagedSession): UserInputRequest | undefined {
    const objectiveUserMessageId = managed.activeObjective?.userMessageId
    const requests = managed.userInputRequests?.filter(candidate => (
      candidate.status === 'answered'
      && !!candidate.responseMessageId
      && candidate.sessionId === managed.id
      && candidate.originWorkspaceId === managed.workspace.id
      && !!objectiveUserMessageId
      && candidate.objectiveUserMessageId === objectiveUserMessageId
    )) ?? []
    const qualified = requests.filter(request => {
      if (!request.responseMessageId || !request.answers?.length) return false
      const matches = managed.messages.filter(message => message.id === request.responseMessageId)
      const answer = matches[0]
      const queued = managed.messageQueue.filter(item => (
        item.messageId === request.responseMessageId
        && item.options?.hidden === true
        && item.options.internalOrigin?.kind === 'user-input'
        && !item.options.automaticRecovery
      ))
      return matches.length === 1 && queued.length === 1 && !!answer && answer.role === 'user'
        && answer.hidden === true && answer.isQueued === true && !answer.isPending
        && !answer.agentDelivery && answer.internalOrigin?.kind === 'user-input'
        && canonicalUserInputAnswerContents(request).includes(answer.content)
        && queued[0]!.message === answer.content
    })
    return qualified.length === 1 ? qualified[0] : undefined
  }

/** A hard-cost answer queued behind an agent delivery is a durable one-use
   * capability for that delivery, not a second provider turn. Validate the
   * complete persisted answer envelope before letting the FIFO head consume it. */
export function queuedCostLimitContinuationForAgentDelivery(managed: ManagedSession): {
    request: UserInputRequest
    message: Message
    queueIndex: number
  } | undefined {
    const objectiveUserMessageId = managed.activeObjective?.userMessageId
    if (!objectiveUserMessageId || managed.activeObjective?.terminalState !== 'active') return undefined
    const qualified = (managed.userInputRequests ?? []).flatMap(request => {
      if (request.status !== 'answered'
        || request.sessionId !== managed.id
        || request.originWorkspaceId !== managed.workspace.id
        || request.objectiveUserMessageId !== objectiveUserMessageId
        || !request.responseMessageId
        || !isCostLimitContinuationAnswer(request)) return []
      const messages = managed.messages.filter(candidate => candidate.id === request.responseMessageId)
      const message = messages[0]
      if (messages.length !== 1 || !message || message.role !== 'user'
        || message.hidden !== true || message.isQueued !== true || message.isPending
        || message.agentDelivery || message.internalOrigin?.kind !== 'user-input'
        || !canonicalUserInputAnswerContents(request).includes(message.content)) return []
      const queueIndexes = managed.messageQueue.flatMap((item, index) => (
        item.messageId === message.id
          && item.message === message.content
          && item.options?.hidden === true
          && item.options.internalOrigin?.kind === 'user-input'
          && !item.options.automaticRecovery
          ? [index] : []
      ))
      return queueIndexes.length === 1 ? [{ request, message, queueIndex: queueIndexes[0]! }] : []
    })
    return qualified.length === 1 ? qualified[0] : undefined
  }

/** Visible accepted chat turns only. Validated user-input answers are human
   * input too, but they refine a pending question and must never cancel an
   * unrelated authentication/permission handoff. */
export function queuedDirectHumanContinuationIndex(managed: ManagedSession): number {
    return managed.messageQueue.findIndex(item => {
      if (!item.messageId || item.options?.hidden || item.options?.internalOrigin || item.options?.automaticRecovery) return false
      // A duplicated persisted identifier is ambiguous and therefore cannot
      // authenticate either a cold resume or a live supersession capability.
      if (managed.messageQueue.filter(candidate => candidate.messageId === item.messageId).length !== 1) return false
      const matches = managed.messages.filter(message => message.id === item.messageId)
      const saved = matches[0]
      if (matches.length !== 1) return false
      return saved?.role === 'user' && saved.isQueued && !saved.isPending && !saved.hidden
        && !saved.internalOrigin && !saved.agentDelivery && saved.content === item.message
    })
  }

export function queuedDirectHumanContinuationIndexForId(managed: ManagedSession, messageId: string): number {
    const index = managed.messageQueue.findIndex(item => item.messageId === messageId)
    if (index < 0) return -1
    const item = managed.messageQueue[index]!
    if (item.options?.hidden || item.options?.internalOrigin || item.options?.automaticRecovery
      || managed.messageQueue.filter(candidate => candidate.messageId === messageId).length !== 1) return -1
    const matches = managed.messages.filter(message => message.id === messageId)
    const saved = matches[0]
    return matches.length === 1 && saved?.role === 'user' && saved.isQueued && !saved.isPending
      && !saved.hidden && !saved.internalOrigin && !saved.agentDelivery && saved.content === item.message
      ? index : -1
  }

export function isDirectHumanContinuation(
    managed: ManagedSession,
    message: string,
    options?: SendMessageOptions,
    existingMessageId?: string,
  ): boolean {
    if (options?.hidden || options?.internalOrigin || options?.automaticRecovery) return false
    if (!existingMessageId) return true
    const matches = managed.messages.filter(candidate => candidate.id === existingMessageId)
    const saved = matches[0]
    if (matches.length !== 1) return false
    return saved?.role === 'user' && saved.isQueued === true && !saved.isPending
      && !saved.hidden && !saved.internalOrigin && !saved.agentDelivery && saved.content === message
  }
