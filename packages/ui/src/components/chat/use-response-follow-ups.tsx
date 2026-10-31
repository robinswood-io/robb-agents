import * as React from 'react';
import { useEffect, useCallback } from 'react';

import type { AnnotationV1 } from '@craft-agent/core';

import { type IslandTransitionConfig } from '../ui';

import { buildAnnotationChipEntryTransition } from '../annotations/island-motion';

import { extractAnnotationSelectedText } from './follow-up-helpers';
import { getAnnotationNoteText } from '../annotations/follow-up-state';
import { hasExistingTextRangeAnnotation, createTextSelectionAnnotation } from '../annotations/annotation-core';

import { clearDomSelection } from '../annotations/selection-restore';

import { type AnnotationIslandMode, type AnchoredSelection } from '../annotations/interaction-state-machine';

import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore';

import { type OpenAnnotationRequest } from "./turn-card-contracts";

interface useResponseFollowUpsInput {
  requestEdit: () => void
  messageId: string | undefined
  activeAnnotationDetail: import("../annotations/interaction-state-machine").ActiveAnnotationDetail | null
  onUpdateAnnotation: ((messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void) | undefined
  activeAnnotation: AnnotationV1 | null
  closeSelectionMenu: () => void
  markSubmitSuccess: () => void
  text: string
  onAddAnnotation: ((messageId: string, annotation: AnnotationV1) => void) | undefined
  pendingSelection: AnchoredSelection | null
  annotations: AnnotationV1[] | undefined
  sessionId: string | undefined
  onSaveAndSendFollowUp: ((target: { messageId: string; annotationId: string; note: string; selectedText: string; }) => void) | undefined
  contentLayerRef: React.RefObject<HTMLDivElement | null>
  cancelFollowUp: () => { hadPendingSelection: boolean; pendingSelection: AnchoredSelection | null; }
  allowAnnotationIsland: boolean
  setSelectionMenuTransitionConfig: React.Dispatch<React.SetStateAction<IslandTransitionConfig>>
  triggerSelectionMenuEntryReplay: () => void
  openFromAnnotation: (detail: import("../annotations/interaction-state-machine").ActiveAnnotationDetail, noteText: string, mode: AnnotationIslandMode) => void
  consumeExternalOpenRequest: (request: import("../annotations/use-annotation-interaction-controller").ExternalOpenAnnotationRequest | null | undefined, params: { messageId?: string; annotations?: AnnotationV1[]; getNoteText: (annotation: AnnotationV1) => string; fallbackAnchor: { x: number; y: number; }; }) => boolean
  openAnnotationRequest: OpenAnnotationRequest | null | undefined
  onRemoveAnnotation: ((messageId: string, annotationId: string) => void) | undefined
  markDeleteSuccess: () => void
}

export function useResponseFollowUps({
  requestEdit,
  messageId,
  activeAnnotationDetail,
  onUpdateAnnotation,
  activeAnnotation,
  closeSelectionMenu,
  markSubmitSuccess,
  text,
  onAddAnnotation,
  pendingSelection,
  annotations,
  sessionId,
  onSaveAndSendFollowUp,
  contentLayerRef,
  cancelFollowUp,
  allowAnnotationIsland,
  setSelectionMenuTransitionConfig,
  triggerSelectionMenuEntryReplay,
  openFromAnnotation,
  consumeExternalOpenRequest,
  openAnnotationRequest,
  onRemoveAnnotation,
  markDeleteSuccess,
}: useResponseFollowUpsInput) {
const handleRequestFollowUpEdit = useCallback(() => {
    requestEdit()
  }, [requestEdit])

const saveFollowUp = useCallback(async (note: string): Promise<{
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  } | null> => {
    const normalizedNote = note.trim()

    if (!messageId) return null

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return null
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta["followUp"]

      try {
        await Promise.resolve(onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
          body: nextBody,
          intent: normalizedNote.length > 0 ? 'comment' : 'highlight',
          updatedAt: Date.now(),
          meta: normalizedNote.length > 0
            ? {
                ...nextMeta,
                followUp: {
                  text: normalizedNote,
                  updatedAt: Date.now(),
                },
              }
            : nextMeta,
        }))
      } catch {
        return null
      }

      markSubmitSuccess()

      if (normalizedNote.length === 0) return null

      return {
        messageId,
        annotationId: activeAnnotationDetail.annotationId,
        note: normalizedNote,
        selectedText: extractAnnotationSelectedText(activeAnnotation, text),
      }
    }

    if (!onAddAnnotation || !pendingSelection) return null

    if (hasExistingTextRangeAnnotation(annotations, pendingSelection.start, pendingSelection.end)) {
      closeSelectionMenu()
      return null
    }

    const annotation = createTextSelectionAnnotation(messageId, pendingSelection, normalizedNote, sessionId ?? '')

    try {
      await Promise.resolve(onAddAnnotation(messageId, annotation))
    } catch {
      return null
    }

    markSubmitSuccess()
    clearDomSelection()

    if (normalizedNote.length === 0) return null

    return {
      messageId,
      annotationId: annotation.id,
      note: normalizedNote,
      selectedText: pendingSelection.selectedText,
    }
  }, [
    messageId,
    activeAnnotationDetail,
    activeAnnotation,
    onUpdateAnnotation,
    onAddAnnotation,
    pendingSelection,
    annotations,
    closeSelectionMenu,
    sessionId,
    markSubmitSuccess,
    text,
  ])

const handleSubmitFollowUp = useCallback((note: string) => {
    void saveFollowUp(note)
  }, [saveFollowUp])

const handleSubmitAndSendFollowUp = useCallback((note: string) => {
    void saveFollowUp(note).then((savedFollowUp) => {
      if (!savedFollowUp) return
      onSaveAndSendFollowUp?.(savedFollowUp)
    })
  }, [saveFollowUp, onSaveAndSendFollowUp])

const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

const handleOpenAnnotationDetail = useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    if (!allowAnnotationIsland) return

    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    const transition = buildAnnotationChipEntryTransition()

    setSelectionMenuTransitionConfig(transition)
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
  }, [allowAnnotationIsland, annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

useEffect(() => {
    if (!allowAnnotationIsland) return

    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      ...(messageId !== undefined ? { messageId: messageId } : {}),
      ...(annotations !== undefined ? { annotations: annotations } : {}),
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    allowAnnotationIsland,
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])

const handleDeleteActiveAnnotation = useCallback(() => {
    if (!onRemoveAnnotation || !messageId || !activeAnnotationDetail) return

    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, messageId, activeAnnotationDetail, markDeleteSuccess])
return { handleCancelFollowUp, handleRequestFollowUpEdit, handleSubmitFollowUp, handleSubmitAndSendFollowUp, handleDeleteActiveAnnotation, handleOpenAnnotationDetail }
}
