import * as React from 'react';
import { Markdown } from '../markdown';
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu';
import { hasExistingTextRangeAnnotation, createSelectionPreviewAnnotation, createTextSelectionAnnotation, type AnnotationOverlayRect } from '../annotations/annotation-core';
import { getAnnotationNoteText, formatAnnotationFollowUpTooltipText } from '../annotations/follow-up-state';
import { type PointerSnapshot, buildAnnotationChipEntryTransition } from '../annotations/island-motion';
import "../annotations/interaction-policy";
import { computeAnnotationOverlayGeometry, type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry';
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer';
import { getAnnotationInteractionAnchor, getAnnotationInteractionSourceKey, hasAnnotationInteraction } from '../annotations/interaction-selectors';
import { useAnnotationInteractionController, type ExternalOpenAnnotationRequest } from '../annotations/use-annotation-interaction-controller';
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation';
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events';
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore';
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config';
import { clearDomSelection } from '../annotations/selection-restore';
import { applyBlockAnnotationMarker, clearBlockAnnotationMarkers } from '../annotations/block-markers';

import { useMarkdownSelection } from "./use-markdown-selection";


import type { AnnotationV1 } from '@craft-agent/core';
import { type IslandTransitionConfig } from '../ui';








import { type AnnotationIslandMode } from '../annotations/interaction-state-machine';








export interface AnnotatableMarkdownDocumentProps {
  content: string
  messageId: string
  sessionId?: string
  annotations?: AnnotationV1[]
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
  sendMessageKey?: 'enter' | 'cmd-enter'
  islandZIndex?: React.CSSProperties['zIndex']
  openAnnotationRequest?: ExternalOpenAnnotationRequest | null
  isStreaming?: boolean
}

export function AnnotatableMarkdownDocument({
  content,
  messageId,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  onOpenUrl,
  onOpenFile,
  sendMessageKey = 'enter',
  islandZIndex = 'var(--z-island, 400)',
  openAnnotationRequest,
  isStreaming = false,
}: AnnotatableMarkdownDocumentProps) {
  const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })
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
  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = React.useMemo(() => {
    return getAnnotationInteractionSourceKey(interactionState, messageId)
  }, [interactionState, messageId])

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = React.useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = React.useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )
  const [annotationOverlay, setAnnotationOverlay] = React.useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
  } = useAnnotationIslandPresentation({
    anchor: selectionMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  const contentLayerRef = React.useRef<HTMLDivElement>(null)
  const lastPointerRef = React.useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = React.useRef<PointerSnapshot | null>(null)
  const selectionStartedInContentRef = React.useRef(false)

  const closeSelectionMenu = React.useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = React.useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = React.useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  const renderedAnnotations = React.useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || selectionMenuView !== 'confirm-follow-up') {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId, sessionId])

  const activeAnnotation = React.useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

  React.useEffect(() => {
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
      return { rects: geometry.rects, chips: geometry.chips }
    }

    // Full recompute: rewrites block-marker DOM. Used for content/annotation changes.
    const recomputeOverlay = () => {
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
  }, [renderedAnnotations, annotations, content])

  React.useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

  const handleOpenFollowUpView = React.useCallback(() => {
    if (!pendingSelection) return
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = React.useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const handleSubmitFollowUp = React.useCallback((note: string) => {
    const normalizedNote = note.trim()

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta.followUp

      onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
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
          : (Object.keys(nextMeta).length > 0 ? nextMeta : undefined),
      })

      markSubmitSuccess()
      return
    }

    if (!pendingSelection || !canAnnotate || !onAddAnnotation) {
      closeSelectionMenu()
      return
    }

    const annotation = createTextSelectionAnnotation(messageId, pendingSelection, normalizedNote, sessionId ?? '')
    onAddAnnotation(messageId, annotation)
    markSubmitSuccess()
    clearDomSelection()
  }, [activeAnnotationDetail, onUpdateAnnotation, activeAnnotation, closeSelectionMenu, pendingSelection, canAnnotate, onAddAnnotation, messageId, sessionId, markSubmitSuccess])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

  const handleDeleteActiveAnnotation = React.useCallback(() => {
    if (!onRemoveAnnotation || !activeAnnotationDetail) return
    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, activeAnnotationDetail, messageId, markDeleteSuccess])

  const handleOpenAnnotationDetail = React.useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
    selectionMenuOpenedAtRef.current = Date.now()
  }, [annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  React.useEffect(() => {
    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      messageId,
      annotations,
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])
  const { handleSelectionPointerDown, handleTextSelection } = useMarkdownSelection({
    contentLayerRef,
    canAnnotate,
    closeSelectionMenu,
    annotations,
    lastPointerRef,
    dragStartPointerRef,
    setSelectionMenuTransitionConfig,
    triggerSelectionMenuEntryReplay,
    openFromSelection,
    selectionMenuOpenedAtRef,
    selectionStartedInContentRef,
    onAddAnnotation,
    sessionId,
    messageId,
    interactionState,
    isSelectionMenuVisible,
    isTargetInsideAnnotationIsland,
  })

  const handleSelectionMenuRequestBack = React.useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

  useAnnotationIslandEvents({
    enabled: hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  const selectionMenu = (
    <AnnotationIslandMenu
      anchor={selectionMenuRenderAnchor}
      sourceKey={selectionMenuRenderSourceKey}
      replayNonce={selectionMenuShowNonce}
      isVisible={isSelectionMenuVisible}
      activeView={selectionMenuView}
      mode={followUpMode}
      draft={followUpDraft}
      onDraftChange={setFollowUpDraft}
      onOpenFollowUp={handleOpenFollowUpView}
      onCancel={handleCancelFollowUp}
      onRequestBack={handleSelectionMenuRequestBack}
      onRequestEdit={handleRequestFollowUpEdit}
      onSubmit={handleSubmitFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      zIndex={islandZIndex}
      usePortal={shouldRenderAnnotationIslandInPortal('fullscreen')}
    />
  )

  return (
    <>
      <div
        ref={contentLayerRef}
        className="relative"
        onMouseDown={handleSelectionPointerDown}
        onMouseUp={handleTextSelection}
      >
        <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile} hideFirstMermaidExpand={false}>
          {content}
        </Markdown>

        <AnnotationOverlayLayer
          rects={annotationOverlay.rects}
          chips={annotationOverlay.chips}
          annotations={renderedAnnotations}
          getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
          onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
            handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
          }}
        />
      </div>
      {selectionMenu}
    </>
  )
}
