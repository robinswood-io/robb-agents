import type { SendMessageOptions } from '../../../../packages/shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import React, { useCallback } from 'react';

import type { Session, Message, FileAttachment, StoredAttachment, ContentBadge } from '../shared/types';

import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions';
import { defaultSessionOptions, mergeSessionOptions } from './hooks/useSessionOptions';
import { generateMessageId } from '../shared/types';

import { sessionAtomFamily } from '@/atoms/sessions';

import { extractBadges } from '@/lib/mentions';

interface useAppMessageSendingInput {
  store: import("jotai").Store
  updateSessionById: (sessionId: string, updates: Partial<Session> | ((session: Session) => Partial<Session>)) => void
  windowWorkspaceSlug: string | null
  skills: import("@craft-agent/shared/skills").LoadedSkill[]
  sources: import("@craft-agent/shared/sources").LoadedSource[]
  setSessionOptions: React.Dispatch<React.SetStateAction<Map<string, SessionOptions>>>
}

export function useAppMessageSending({
  store,
  updateSessionById,
  windowWorkspaceSlug,
  skills,
  sources,
  setSessionOptions,
}: useAppMessageSendingInput) {
const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[]) => {
    try {
      // Capture pre-send processing state so we can flag mid-stream sends
      // for the queued badge (#616 follow-up — covers Pi steer path which
      // returns status 'accepted', not 'queued').
      const sendingMidStream = store.get(sessionAtomFamily(sessionId))?.isProcessing === true

      // Step 1: Store attachments and get persistent metadata
      let storedAttachments: StoredAttachment[] | undefined
      let processedAttachments: FileAttachment[] | undefined

      if (attachments?.length) {
        // Store each attachment to disk (generates thumbnails, converts Office→markdown)
        // Use allSettled so one failure doesn't kill all attachments
        const storeResults = await Promise.allSettled(
          attachments.map(a => window.electronAPI.storeAttachment(sessionId, a))
        )

        // Filter successful stores, warn about failures
        const stored: StoredAttachment[] = []
        const successfulAttachments: FileAttachment[] = []
        const failedNames: string[] = []
        for (const [index, result] of storeResults.entries()) {
          const attachment = attachments[index]
          if (!attachment) throw new Error(`Missing attachment at index ${index}`)
          if (result.status === 'fulfilled') {
            stored.push(result.value)
            successfulAttachments.push(omitUndefined({
              ...attachment,
              storedPath: result.value.storedPath,
              markdownPath: result.value.markdownPath,
              base64: result.value.resizedBase64 ?? attachment.base64,
            }))
          } else {
            failedNames.push(attachment.name)
            console.warn(`Failed to store attachment "${attachment.name}":`, result.reason)
          }
        }
        storedAttachments = stored
        processedAttachments = successfulAttachments

        if (failedNames.length > 0) {
          console.warn(`${failedNames.length} attachment(s) failed to store`)
          updateSessionById(sessionId, (s) => ({
            messages: [...s.messages, {
              id: generateMessageId(),
              role: 'warning' as const,
              content: `⚠️ ${failedNames.length} attachment(s) could not be stored and will not be sent: ${failedNames.join(', ')}`,
              timestamp: Date.now()
            }]
          }))
        }
      }

      // Step 3: Extract badges from mentions (sources/skills) with embedded icons
      // Badges are self-contained for display in UserMessageBubble and viewer
      // Merge with any externally provided badges (e.g., from EditPopover context badges)
      // Use workspace slug (not UUID) for skill qualification - SDK expects "workspaceSlug:skillSlug"
      const mentionBadges: ContentBadge[] = windowWorkspaceSlug
        ? extractBadges(message, skills, sources, windowWorkspaceSlug)
        : []
      const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

      // Step 4.1: Detect SDK slash commands (e.g., /compact) and create command badges
      // This makes /compact render as an inline badge rather than raw text
      const commandMatch = message.match(/^\/([a-z]+)(\s|$)/i)
      if (commandMatch?.[1]?.toLowerCase() === 'compact') {
        const commandText = commandMatch[0].trimEnd() // "/compact" without trailing space
        badges.unshift({
          type: 'command',
          label: 'Compact',
          rawText: commandText,
          start: 0,
          end: commandText.length,
        })
      }

      // Step 4.2: Detect plan execution messages and create file badges
      // Pattern: "Read the plan at <path> and execute it."
      // This is sent after compaction when accepting a plan, displays as clickable file badge
      // Only the file path is replaced with a badge - surrounding text remains visible
      const planExecuteMatch = message.match(/^(Read the plan at )(.+?)( and execute it\.?)$/i)
      const prefix = planExecuteMatch?.[1]
      const filePath = planExecuteMatch?.[2]
      if (prefix !== undefined && filePath !== undefined) {
        const fileName = filePath.split('/').pop() || 'plan.md'
        badges.push(omitUndefined<ContentBadge>({
          type: 'file',
          label: fileName,
          rawText: filePath,
          ...(filePath !== undefined ? { filePath: filePath } : {}),
          start: prefix.length,
          end: prefix.length + filePath.length,
        }))
      }

      // Step 5: Create user message with StoredAttachments (for UI display)
      // Mark as isPending for optimistic UI — will be confirmed by user_message
      // event. Flag mid-stream sends as queued so the bubble renders with the
      // dashed-draft treatment immediately. Applies to both backends:
      // Pi steers (server emits status: 'accepted' but the renderer preserves
      // isQueued through that update) and Claude queues (server emits 'queued'
      // which confirms it). Cleared by 'processing' status or when the current
      // turn ends.
      const userMessage: Message = omitUndefined<Message>({
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        ...(storedAttachments !== undefined ? { attachments: storedAttachments } : {}),
        badges: badges.length > 0 ? badges : undefined,
        isPending: true,  // Optimistic - will be confirmed by backend
        isQueued: sendingMidStream,
      })

      // Optimistic UI update - add user message and set processing state
      updateSessionById(sessionId, (s) => ({
        messages: [...s.messages, userMessage],
        isProcessing: true,
        lastMessageAt: Date.now()
      }))

      // Step 6: Send to Claude with processed attachments + stored attachments for persistence
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, storedAttachments, omitUndefined<SendMessageOptions>({
        skillSlugs,
        badges: badges.length > 0 ? badges : undefined,
        optimisticMessageId: userMessage.id,
      }))
    } catch (error) {
      console.error('Failed to send message:', error)
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: [
          ...s.messages,
          {
            id: generateMessageId(),
            role: 'error' as const,
            content: `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now()
          }
        ]
      }))
    }
  }, [updateSessionById, skills, sources, store, windowWorkspaceSlug])

const handleSessionOptionsChange = useCallback((sessionId: string, updates: SessionOptionUpdates) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      next.set(sessionId, mergeSessionOptions(current, updates))
      return next
    })

    // Handle persistence/backend for specific options
    if (updates.permissionMode !== undefined) {
      // Sync permission mode change with backend
      window.electronAPI.sessionCommand(sessionId, { type: 'setPermissionMode', mode: updates.permissionMode })
    }
    if (updates.thinkingLevel !== undefined) {
      // Sync thinking level change with backend (session-level, persisted)
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
  }, [setSessionOptions])
return { handleSendMessage, handleSessionOptionsChange }
}
