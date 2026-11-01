import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";

import { useMemo } from "react";

import type { Session } from "../../../shared/types";

import { asRecord, getAnnotationNoteText, isAnnotationFollowUpSent, extractAnnotationSelectedText, normalizeFollowUpText } from "@craft-agent/ui";

import { truncateForChipTooltip, type PendingFollowUpAnnotation } from './ChatDisplay.follow-ups';

interface useChatFollowUpsInput {
  session: Session | null
}

export function useChatFollowUps({
  session,
}: useChatFollowUpsInput) {
const totalTurnCountRef = React.useRef(0)

const messageCount = session?.messages.length ?? 0

const lastMessage = messageCount > 0 ? session?.messages[messageCount - 1] : undefined

const lastMessageId = lastMessage?.id

const lastMessageRole = lastMessage?.role

const pendingFollowUpAnnotations = useMemo<PendingFollowUpAnnotation[]>(() => {
    if (!session?.messages?.length) return []

    const pending: PendingFollowUpAnnotation[] = []

    for (const message of session.messages) {
      if (message.role !== 'assistant' && message.role !== 'plan') continue
      if (!message.annotations?.length) continue

      for (const annotation of message.annotations) {
        const note = getAnnotationNoteText(annotation)
        if (!note) continue
        if (isAnnotationFollowUpSent(annotation)) continue

        pending.push(omitUndefined<PendingFollowUpAnnotation>({
          messageId: message.id,
          annotationId: annotation.id,
          note,
          selectedText: extractAnnotationSelectedText(annotation, message.content),
          createdAt: annotation.updatedAt ?? annotation.createdAt,
          ...(annotation.style?.color !== undefined ? { color: annotation.style?.color } : {}),
          meta: asRecord(annotation.meta) ?? undefined,
        }))
      }
    }

    return pending.sort((a, b) => a.createdAt - b.createdAt)
  }, [session?.messages])

const followUpInputItems = useMemo(() => {
    return pendingFollowUpAnnotations.map((followUp, idx) => ({
      id: `${followUp.messageId}:${followUp.annotationId}`,
      messageId: followUp.messageId,
      annotationId: followUp.annotationId,
      index: idx + 1,
      noteLabel: normalizeFollowUpText(followUp.note),
      selectedText: truncateForChipTooltip(followUp.selectedText, 260),
      color: followUp.color,
    }))
  }, [pendingFollowUpAnnotations])
return { totalTurnCountRef, lastMessageId, messageCount, lastMessageRole, pendingFollowUpAnnotations, followUpInputItems }
}
