import * as React from 'react';
import { useMemo, useEffect, useCallback } from 'react';

import type { AnnotationV1 } from '@craft-agent/core';

import { type PointerSnapshot } from '../annotations/island-motion';

import { hasExistingTextRangeAnnotation, createSelectionPreviewAnnotation, type AnnotationOverlayRect } from '../annotations/annotation-core';

import { clearBlockAnnotationMarkers, applyBlockAnnotationMarker } from '../annotations/block-markers';

import { clearDomSelection } from '../annotations/selection-restore';

import { computeAnnotationOverlayGeometry, type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry';

import { hasAnnotationInteraction } from '../annotations/interaction-selectors';
import { type AnchoredSelection } from '../annotations/interaction-state-machine';

import { clearAnnotationMarks } from "./turn-card-response-helpers";

interface useResponseAnnotationsInput {
  annotations: AnnotationV1[] | undefined
  pendingSelection: AnchoredSelection | null
  selectionMenuView: import("../annotations/interaction-state-machine").AnnotationIslandView
  messageId: string | undefined
  sessionId: string | undefined
  activeAnnotationDetail: import("../annotations/interaction-state-machine").ActiveAnnotationDetail | null
  closeSelectionMenu: () => void
  contentLayerRef: React.RefObject<HTMLDivElement | null>
  setAnnotationOverlay: React.Dispatch<React.SetStateAction<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[]; }>>
  text: string
  displayedText: string
  isStreaming: boolean
  canAnnotate: boolean
  resetPresentation: () => void
  dragStartPointerRef: React.RefObject<PointerSnapshot | null>
  lastPointerRef: React.RefObject<PointerSnapshot | null>
  interactionState: import("../annotations/interaction-state-machine").AnnotationInteractionState
  isSelectionMenuVisible: boolean
  selectionMenuOpenedAtRef: React.MutableRefObject<number>
  isTargetInsideAnnotationIsland: (target: Node | null) => boolean
  openFollowUpFromSelection: () => void
}

export function useResponseAnnotations({
  annotations,
  pendingSelection,
  selectionMenuView,
  messageId,
  sessionId,
  activeAnnotationDetail,
  closeSelectionMenu,
  contentLayerRef,
  setAnnotationOverlay,
  text,
  displayedText,
  isStreaming,
  canAnnotate,
  resetPresentation,
  dragStartPointerRef,
  lastPointerRef,
  interactionState,
  isSelectionMenuVisible,
  selectionMenuOpenedAtRef,
  isTargetInsideAnnotationIsland,
  openFollowUpFromSelection,
}: useResponseAnnotationsInput) {
const renderedAnnotations = useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || selectionMenuView !== 'confirm-follow-up' || !messageId) {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId])

const activeAnnotation = useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

useEffect(() => {
    if (!activeAnnotationDetail) return
    if (!activeAnnotation) {
      closeSelectionMenu()
    }
  }, [activeAnnotationDetail, activeAnnotation, closeSelectionMenu])

useEffect(() => {
    const root = contentLayerRef.current
    if (!root) {
      setAnnotationOverlay({ rects: [], chips: [] })
      return
    }

    const computeGeometry = () => {
      if (!renderedAnnotations.length) return { rects: [], chips: [] }
      const geometry = computeAnnotationOverlayGeometry({
        root,
        renderedAnnotations,
        persistedAnnotations: annotations,
      })
      if (process.env.NODE_ENV !== 'production' && geometry.unresolved.length > 0) {
        console.debug('[annotations] unresolved annotations', {
          count: geometry.unresolved.length,
          ids: geometry.unresolved.map(item => item.annotation.id),
          reasons: geometry.unresolved.map(item => item.reason),
        })
      }
      return { rects: geometry.rects, chips: geometry.chips }
    }

    // Full recompute: rewrites block-marker DOM. Used for content/annotation changes.
    const recomputeOverlay = () => {
      clearAnnotationMarks(root)
      clearBlockAnnotationMarkers(root)

      if (!renderedAnnotations.length) {
        setAnnotationOverlay({ rects: [], chips: [] })
        return
      }

      const next = computeGeometry()
      for (const annotation of renderedAnnotations) {
        applyBlockAnnotationMarker(root, annotation)
      }
      setAnnotationOverlay(next)
    }

    // Fast path: coordinates only, no DOM mutation. Used by scroll/resize.
    const recomputeOverlayCoords = () => {
      if (!renderedAnnotations.length) return
      setAnnotationOverlay(computeGeometry())
    }

    let rafId: number | null = null
    const scheduleCoordsRecompute = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        recomputeOverlayCoords()
      })
    }

    recomputeOverlay()
    window.addEventListener('resize', scheduleCoordsRecompute)
    // Capture-phase: scroll events don't bubble, but capture-phase listeners on
    // ancestors fire for descendant scrolls — so this catches the overflow-auto
    // viewport inside MarkdownDocBlock (and any future nested scroll surface).
    root.addEventListener('scroll', scheduleCoordsRecompute, { capture: true, passive: true })
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', scheduleCoordsRecompute)
      root.removeEventListener('scroll', scheduleCoordsRecompute, { capture: true } as EventListenerOptions)
    }
  }, [annotations, renderedAnnotations, text, displayedText, isStreaming])

useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

useEffect(() => {
    // Session switches should fully reset local island UI state to avoid stale
    // "hot" instances suppressing entry animations in the newly focused session.
    closeSelectionMenu()
    resetPresentation()
    dragStartPointerRef.current = null
    lastPointerRef.current = null
  }, [sessionId, closeSelectionMenu, resetPresentation])

useEffect(() => {
    if (!hasAnnotationInteraction(interactionState) || !isSelectionMenuVisible) return

    const handleSelectionChange = () => {
      if (Date.now() - selectionMenuOpenedAtRef.current < 180) {
        return
      }

      const root = contentLayerRef.current
      if (!root) {
        closeSelectionMenu()
        return
      }

      const selection = window.getSelection()
      // Keep the island open if selection was programmatically cleared by a render update.
      // This happens during streaming/DOM reconciliation and should not dismiss follow-up UI.
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

      // Selecting text inside the island (e.g. follow-up textarea) should not close it.
      if (commonElement && isTargetInsideAnnotationIsland(commonElement)) {
        return
      }

      if (!root.contains(common)) {
        closeSelectionMenu()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [interactionState, isSelectionMenuVisible, closeSelectionMenu, isTargetInsideAnnotationIsland, selectionMenuOpenedAtRef])

const handleOpenFollowUpView = useCallback(() => {
    if (!pendingSelection) return

    // Native browser selection steals typing focus from the follow-up textarea.
    // Keep semantic selection in pendingSelection and clear only the DOM selection.
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])
return { activeAnnotation, handleOpenFollowUpView, renderedAnnotations }
}
