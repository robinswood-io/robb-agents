import * as React from "react";

import { useCallback } from "react";

import { toast } from "sonner";

import { coerceInputText, appendRestoredInput } from "@/lib/input-text";

import type { Session, FileAttachment, PermissionRequest, CredentialResponse } from "../../../shared/types";

import { asRecord } from "@craft-agent/ui";

import { type StructuredInputState, type StructuredResponse, type PermissionResponse, type AdminApprovalResponse, type StructuredCredentialResponse } from "./input";

import { stopConversation } from "./stop-conversation";

import { formatFollowUpSection, normalizeFollowUpsMarkdown, type PendingFollowUpAnnotation } from './ChatDisplay.follow-ups';

interface useChatActionsInput {
  pendingFollowUpAnnotations: PendingFollowUpAnnotation[]
  isStickToBottomRef: React.RefObject<boolean>
  setShowScrollToLatest: React.Dispatch<React.SetStateAction<boolean>>
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  session: Session | null
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  isInputDisabled: boolean
  disableSend: boolean
  connectionUnavailable: boolean
  t: import("i18next").TFunction<"translation", undefined>
  isConversationProcessing: boolean
  onInputChange: ((value: string) => void) | undefined
  inputValue: string | undefined
  activeDescendantIds: string[]
  scrollViewportRef: React.RefObject<HTMLDivElement | null>
  onRespondToPermission: ((sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: import("../../../shared/types").PermissionResponseOptions) => void) | undefined
  onRespondToCredential: ((sessionId: string, requestId: string, response: CredentialResponse) => void | Promise<void>) | undefined
  pendingPermission: PermissionRequest | undefined
  pendingCredential: import("@craft-agent/session-tools-core").CredentialAuthRequest | undefined
}

export function useChatActions({
  pendingFollowUpAnnotations,
  isStickToBottomRef,
  setShowScrollToLatest,
  onSendMessage,
  session,
  messagesEndRef,
  isInputDisabled,
  disableSend,
  connectionUnavailable,
  t,
  isConversationProcessing,
  onInputChange,
  inputValue,
  activeDescendantIds,
  scrollViewportRef,
  onRespondToPermission,
  onRespondToCredential,
  pendingPermission,
  pendingCredential,
}: useChatActionsInput) {
const handleSubmit = (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => {
    const hasBaseMessage = message.trim().length > 0
    const followUpSection = formatFollowUpSection(pendingFollowUpAnnotations, {
      includeTopSeparator: hasBaseMessage,
    })
    const messageWithFollowUps = followUpSection.length > 0
      ? (hasBaseMessage ? `${message}\n\n${followUpSection}` : followUpSection)
      : message
    const normalizedMessage = normalizeFollowUpsMarkdown(messageWithFollowUps)

    // Force stick-to-bottom when user sends a message
    isStickToBottomRef.current = true
    setShowScrollToLatest(false)
    onSendMessage(normalizedMessage, attachments, skillSlugs)

    // Persist sent marker on follow-up annotations so TurnCard can distinguish
    // sent vs pending follow-ups. If user edits a follow-up later, TurnCard
    // clears these markers and the annotation becomes pending again.
    if (session && pendingFollowUpAnnotations.length > 0) {
      const sentAt = Date.now()
      void Promise.all(pendingFollowUpAnnotations.map((followUp) => {
        const currentMeta = followUp.meta ?? {}
        const currentFollowUpMeta = asRecord(currentMeta.followUp) ?? {}

        return window.electronAPI.sessionCommand(session.id, {
          type: 'updateAnnotation',
          messageId: followUp.messageId,
          annotationId: followUp.annotationId,
          patch: {
            meta: {
              ...currentMeta,
              followUp: {
                ...currentFollowUpMeta,
                text: followUp.note,
                lastSentAt: sentAt,
                lastSentText: followUp.note,
              },
            },
          },
        })
      })).catch((error) => {
        console.error('[ChatDisplay] Failed to mark follow-up annotations as sent:', error)
      })
    }

    // Immediately scroll to bottom after sending - use requestAnimationFrame
    // to ensure the DOM has updated with the new message
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }

const handleSaveAndSendFollowUp = useCallback((_target: {
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  }) => {
    if (!session) return

    if (isInputDisabled || disableSend || connectionUnavailable) {
      toast.error(t('toast.cannotSendRightNow'), {
        description: 'Sending is currently disabled for this session.',
      })
      return
    }

    // Mimic pressing Send in the input after Save completes.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:submit-input', {
        detail: { sessionId: session.id },
      }))
    }, 0)
  }, [session, isInputDisabled, disableSend, connectionUnavailable, t])

const handleStop = (silent = false) => {
    if (!session || !isConversationProcessing) return

    // Explicit Stop (not a redirect/new-message send): put the in-flight prompt
    // back in the input so the user can tweak and resend. Append to any draft.
    // Exclude isQueued messages — those are restored separately by the backend
    // `restore_input` effect (App.tsx) and would otherwise double up here.
    if (!silent) {
      const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user' && !m.isQueued && !m.hidden && !m.internalOrigin)
      const restoredText = coerceInputText(lastUserMsg?.content)
      if (restoredText) {
        onInputChange?.(appendRestoredInput(inputValue, restoredText))
      }
    }

    stopConversation(session.id, activeDescendantIds, silent,
      (id, quiet) => window.electronAPI.cancelProcessing(id, quiet)).catch(error => {
      console.error('[ChatDisplay] Failed to cancel processing:', error)
    })
  }

const handleAnimatedHeightChange = React.useCallback((delta: number) => {
    if (!isStickToBottomRef.current) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    // Adjust scroll to maintain position relative to content
    viewport.scrollTop += delta
  }, [ isStickToBottomRef, scrollViewportRef])

const handleStructuredResponse = (response: StructuredResponse) => {
    if ((response.type === 'permission' || response.type === 'admin_approval') && onRespondToPermission) {
      if (response.type === 'permission') {
        const permResponse = response as PermissionResponse
        return onRespondToPermission(
          permResponse.request.sessionId,
          permResponse.request.requestId,
          permResponse.allowed,
          permResponse.alwaysAllow
        )
      }

      const adminResponse = response as AdminApprovalResponse
      return onRespondToPermission(
        adminResponse.request.sessionId,
        adminResponse.request.requestId,
        adminResponse.approved,
        false,
        { rememberForMinutes: adminResponse.rememberForMinutes }
      )
    } else if (response.type === 'credential' && onRespondToCredential) {
      const credResponse = response as StructuredCredentialResponse
      const { request, ...credentialPayload } = credResponse
      return onRespondToCredential(
        request.sessionId,
        request.requestId,
        credentialPayload
      )
    }
  }

const structuredInput: StructuredInputState | undefined = React.useMemo(() => {
    if (pendingPermission) {
      if (pendingPermission.type === 'admin_approval') {
        return {
          type: 'admin_approval',
          request: pendingPermission,
          data: {
            appName: pendingPermission.appName || pendingPermission.toolName || 'System action',
            reason: pendingPermission.reason || pendingPermission.description,
            impact: pendingPermission.impact,
            command: pendingPermission.command || '',
            requiresSystemPrompt: pendingPermission.requiresSystemPrompt ?? true,
            rememberForMinutes: pendingPermission.rememberForMinutes ?? 10,
          },
        }
      }
      return { type: 'permission', data: pendingPermission }
    }
    if (pendingCredential) {
      return { type: 'credential', data: pendingCredential }
    }
    return undefined
  }, [pendingPermission, pendingCredential])
return { handleSaveAndSendFollowUp, handleAnimatedHeightChange, handleSubmit, handleStop, structuredInput, handleStructuredResponse }
}
