import * as React from 'react';
import { useEffect, useCallback } from 'react';

import type { AnnotationV1 } from '@craft-agent/core';

import { type IslandTransitionConfig } from '../ui';
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu';
import { type PointerSnapshot } from '../annotations/island-motion';

import { formatAnnotationFollowUpTooltipText } from '../annotations/follow-up-state';
import { type AnnotationOverlayRect } from '../annotations/annotation-core';

import { shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config';

import { type AnnotationOverlayChip } from '../annotations/annotation-overlay-geometry';
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer';
import { hasAnnotationInteraction } from '../annotations/interaction-selectors';
import { type AnnotationIslandMode } from '../annotations/interaction-state-machine';

import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events';

interface useResponseSelectionMenuInput {
  canAnnotate: boolean
  onAddAnnotation: ((messageId: string, annotation: AnnotationV1) => void) | undefined
  messageId: string | undefined
  selectionStartedInContentRef: React.RefObject<boolean>
  lastPointerRef: React.RefObject<PointerSnapshot | null>
  contentLayerRef: React.RefObject<HTMLDivElement | null>
  showSelectionMenuFromCurrentSelection: () => void
  selectionMenuView: import("../annotations/interaction-state-machine").AnnotationIslandView
  handleCancelFollowUp: () => void
  allowAnnotationIsland: boolean
  interactionState: import("../annotations/interaction-state-machine").AnnotationInteractionState
  isSelectionMenuVisible: boolean
  selectionMenuOpenedAtRef: React.MutableRefObject<number>
  isTargetInsideAnnotationIsland: (target: Node | null) => boolean
  closeSelectionMenu: () => void
  selectionMenuRenderAnchor: { x: number; y: number; } | null
  selectionMenuRenderSourceKey: string
  selectionMenuShowNonce: number
  followUpMode: AnnotationIslandMode
  followUpDraft: string
  setFollowUpDraft: (draft: string) => void
  handleOpenFollowUpView: () => void
  handleRequestFollowUpEdit: () => void
  handleSubmitFollowUp: (note: string) => void
  handleSubmitAndSendFollowUp: (note: string) => void
  activeAnnotationDetail: import("../annotations/interaction-state-machine").ActiveAnnotationDetail | null
  handleDeleteActiveAnnotation: () => void
  sendMessageKey: "enter" | "cmd-enter"
  selectionMenuTransitionConfig: IslandTransitionConfig
  handleSelectionMenuExitComplete: () => void
  annotationOverlay: { rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[]; }
  renderedAnnotations: AnnotationV1[]
  handleOpenAnnotationDetail: (annotationId: string, index: number, anchorX: number, anchorY: number, mode?: AnnotationIslandMode) => void
}

export function useResponseSelectionMenu({
  canAnnotate,
  onAddAnnotation,
  messageId,
  selectionStartedInContentRef,
  lastPointerRef,
  contentLayerRef,
  showSelectionMenuFromCurrentSelection,
  selectionMenuView,
  handleCancelFollowUp,
  allowAnnotationIsland,
  interactionState,
  isSelectionMenuVisible,
  selectionMenuOpenedAtRef,
  isTargetInsideAnnotationIsland,
  closeSelectionMenu,
  selectionMenuRenderAnchor,
  selectionMenuRenderSourceKey,
  selectionMenuShowNonce,
  followUpMode,
  followUpDraft,
  setFollowUpDraft,
  handleOpenFollowUpView,
  handleRequestFollowUpEdit,
  handleSubmitFollowUp,
  handleSubmitAndSendFollowUp,
  activeAnnotationDetail,
  handleDeleteActiveAnnotation,
  sendMessageKey,
  selectionMenuTransitionConfig,
  handleSelectionMenuExitComplete,
  annotationOverlay,
  renderedAnnotations,
  handleOpenAnnotationDetail,
}: useResponseSelectionMenuInput) {
useEffect(() => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      // Mouseup location reflects the user's final intent for popup anchoring.
      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        ts: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        // In-bounds mouseup is already handled by onMouseUp on the content container.
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, onAddAnnotation, messageId, showSelectionMenuFromCurrentSelection])

const handleSelectionMenuRequestBack = useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

useAnnotationIslandEvents({
    enabled: allowAnnotationIsland && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

const selectionMenu = allowAnnotationIsland ? (
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
      onSubmitAndSend={handleSubmitAndSendFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      usePortal={shouldRenderAnnotationIslandInPortal('turncard')}
    />
  ) : null

const annotationOverlayLayer = (
    <AnnotationOverlayLayer
      rects={annotationOverlay.rects}
      chips={annotationOverlay.chips}
      annotations={renderedAnnotations}
      getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
      allowChipOpen={allowAnnotationIsland}
      onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
        handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
      }}
    />
  )
return { annotationOverlayLayer, selectionMenu }
}
