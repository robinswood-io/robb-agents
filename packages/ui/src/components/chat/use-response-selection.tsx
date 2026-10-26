
import { useMemo, useEffect, useRef, useCallback, useState } from 'react';

import type { AnnotationV1 } from '@craft-agent/core';

import { type IslandTransitionConfig } from '../ui';

import { type PointerSnapshot, buildAnnotationChipEntryTransition } from '../annotations/island-motion';

import { type AnnotationOverlayRect } from '../annotations/annotation-core';

import { canAnnotateMessage } from '../annotations/annotation-host-config';

import { type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry';

import { getAnnotationInteractionAnchor, getAnnotationInteractionSourceKey } from '../annotations/interaction-selectors';

import { useAnnotationInteractionController } from '../annotations/use-annotation-interaction-controller';
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation';

import { type AnnotationInteractionMode } from "./turn-card-contracts";

interface useResponseSelectionInput {
  text: string
  onAddAnnotation: ((messageId: string, annotation: AnnotationV1) => void) | undefined
  messageId: string | undefined
  isStreaming: boolean
  annotationInteractionMode: AnnotationInteractionMode
}

export function useResponseSelection({
  text,
  onAddAnnotation,
  messageId,
  isStreaming,
  annotationInteractionMode,
}: useResponseSelectionInput) {
const [displayedText, setDisplayedText] = useState(text)

const lastUpdateRef = useRef(Date.now())

const [copied, setCopied] = useState(false)

const [isFullscreen, setIsFullscreen] = useState(false)

const [isDarkMode, setIsDarkMode] = useState(false)

const interaction = useAnnotationInteractionController()

const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
    consumeExternalOpenRequest,
  } = interaction

const pendingSelection = interactionState.pendingSelection

const selectionMenuView = interactionState.selectionMenuView

const followUpDraft = interactionState.followUpDraft

const followUpMode = interactionState.followUpMode

const activeAnnotationDetail = interactionState.activeAnnotationDetail

const [selectionMenuShowNonce, setSelectionMenuShowNonce] = useState(0)

const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )

const [annotationOverlay, setAnnotationOverlay] = useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })

const contentRef = useRef<HTMLDivElement>(null)

const contentLayerRef = useRef<HTMLDivElement>(null)

const lastPointerRef = useRef<PointerSnapshot | null>(null)

const dragStartPointerRef = useRef<PointerSnapshot | null>(null)

const selectionStartedInContentRef = useRef(false)

const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })

const allowAnnotationIsland = annotationInteractionMode === 'interactive'

useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    }
    checkDarkMode()

    // Observe class changes on documentElement for theme switches
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

const closeSelectionMenu = useCallback(() => {
    closeAll()
  }, [closeAll])

const isTargetInsideAnnotationIsland = useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

const triggerSelectionMenuEntryReplay = useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

const activeMenuAnchor = useMemo(() => {
    return getAnnotationInteractionAnchor(interactionState)
  }, [interactionState])

const selectionMenuSourceKey = useMemo(() => {
    const messageScope = messageId ?? 'no-message'
    return getAnnotationInteractionSourceKey(interactionState, messageScope)
  }, [interactionState, messageId])

const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
    resetPresentation,
  } = useAnnotationIslandPresentation({
    anchor: activeMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [text])
return { pendingSelection, selectionMenuView, activeAnnotationDetail, closeSelectionMenu, contentLayerRef, setAnnotationOverlay, displayedText, canAnnotate, resetPresentation, dragStartPointerRef, lastPointerRef, interactionState, isSelectionMenuVisible, selectionMenuOpenedAtRef, isTargetInsideAnnotationIsland, openFollowUpFromSelection, requestEdit, markSubmitSuccess, cancelFollowUp, allowAnnotationIsland, setSelectionMenuTransitionConfig, triggerSelectionMenuEntryReplay, openFromAnnotation, consumeExternalOpenRequest, markDeleteSuccess, selectionStartedInContentRef, openFromSelection, selectionMenuRenderAnchor, selectionMenuRenderSourceKey, selectionMenuShowNonce, followUpMode, followUpDraft, setFollowUpDraft, selectionMenuTransitionConfig, handleSelectionMenuExitComplete, annotationOverlay, setDisplayedText, lastUpdateRef, setIsFullscreen, contentRef, isDarkMode, handleCopy, copied, isFullscreen }
}
