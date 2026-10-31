import * as React from 'react';

import type { AnnotationV1 } from '@craft-agent/core';
import { type IslandTransitionConfig } from '../ui';

import { ANNOTATION_PREFIX_SUFFIX_WINDOW, SELECTION_POINTER_MAX_AGE_MS, clamp, hasExistingTextRangeAnnotation, getCanonicalText, resolveNodeOffset } from '../annotations/annotation-core';

import { type PointerSnapshot, buildSelectionEntryTransition } from '../annotations/island-motion';
import { shouldIgnoreSelectionMouseUpTarget } from '../annotations/interaction-policy';

import { hasAnnotationInteraction } from '../annotations/interaction-selectors';

interface useMarkdownSelectionInput {
  contentLayerRef: React.RefObject<HTMLDivElement | null>
  canAnnotate: boolean
  closeSelectionMenu: () => void
  annotations: AnnotationV1[] | undefined
  lastPointerRef: React.RefObject<PointerSnapshot | null>
  dragStartPointerRef: React.RefObject<PointerSnapshot | null>
  setSelectionMenuTransitionConfig: React.Dispatch<React.SetStateAction<IslandTransitionConfig>>
  triggerSelectionMenuEntryReplay: () => void
  openFromSelection: (selection: import("../annotations/interaction-state-machine").AnchoredSelection) => void
  selectionMenuOpenedAtRef: React.MutableRefObject<number>
  selectionStartedInContentRef: React.RefObject<boolean>
  onAddAnnotation: ((messageId: string, annotation: AnnotationV1) => void) | undefined
  sessionId: string | undefined
  messageId: string
  interactionState: import("../annotations/interaction-state-machine").AnnotationInteractionState
  isSelectionMenuVisible: boolean
  isTargetInsideAnnotationIsland: (target: Node | null) => boolean
}

export function useMarkdownSelection({
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
}: useMarkdownSelectionInput) {
const showSelectionMenuFromCurrentSelection = React.useCallback(() => {
    const root = contentLayerRef.current
    if (!root || !canAnnotate) return

    requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        closeSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        closeSelectionMenu()
        return
      }

      const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
      const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) {
        closeSelectionMenu()
        return
      }

      if (hasExistingTextRangeAnnotation(annotations, start, end)) {
        closeSelectionMenu()
        return
      }

      const selectedText = range.toString()
      if (!selectedText || !/\S/.test(selectedText)) {
        closeSelectionMenu()
        return
      }

      const fullText = getCanonicalText(root)
      const prefix = fullText.slice(Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW), start)
      const suffix = fullText.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null
      const pointerY = hasRecentPointer && pointer ? pointer.y : null

      const fallbackRect = range.getBoundingClientRect()
      let anchorRect: DOMRect
      if (rects.length > 0) {
        if (pointerY != null) {
          const rowCandidates = rects.filter(rect => pointerY >= rect.top && pointerY <= rect.bottom)

          if (rowCandidates.length > 0) {
            if (pointerX != null) {
              const xContaining = rowCandidates.filter(rect => pointerX >= rect.left && pointerX <= rect.right)
              if (xContaining.length > 0) {
                anchorRect = xContaining.reduce((best, rect) => (rect.width > best.width ? rect : best))
              } else {
                anchorRect = rowCandidates.reduce((best, rect) => {
                  const bestDistance = Math.min(Math.abs(pointerX - best.left), Math.abs(pointerX - best.right))
                  const rectDistance = Math.min(Math.abs(pointerX - rect.left), Math.abs(pointerX - rect.right))
                  return rectDistance < bestDistance ? rect : best
                })
              }
            } else {
              anchorRect = rowCandidates.reduce((best, rect) => (rect.width > best.width ? rect : best))
            }
          } else {
            anchorRect = rects.reduce((best, rect) => {
              const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointerY)
              const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointerY)
              return rectDistance < bestDistance ? rect : best
            })
          }
        } else {
          anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
        }
      } else {
        anchorRect = fallbackRect
      }

      const anchorRowRects = rects.length > 0
        ? rects.filter(rect => Math.abs(rect.top - anchorRect.top) <= 2)
        : []
      const clampRects = anchorRowRects.length > 0 ? anchorRowRects : (rects.length > 0 ? rects : [anchorRect])
      const selectionMinX = Math.min(...clampRects.map(rect => rect.left))
      const selectionMaxX = Math.max(...clampRects.map(rect => rect.right))

      const anchorX = pointerX != null
        ? clamp(pointerX, selectionMinX, selectionMaxX)
        : (anchorRect.left + (anchorRect.width / 2))
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)

      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()
      openFromSelection({
        start,
        end,
        selectedText,
        prefix,
        suffix,
        anchorX,
        anchorY,
      })
      selectionMenuOpenedAtRef.current = Date.now()
      dragStartPointerRef.current = null
    })
  }, [annotations, canAnnotate, closeSelectionMenu, triggerSelectionMenuEntryReplay])

const handleSelectionPointerDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    selectionStartedInContentRef.current = true
    const snapshot: PointerSnapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }
    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

const handleTextSelection = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) {
      selectionStartedInContentRef.current = false
      return
    }

    lastPointerRef.current = { x: event.clientX, y: event.clientY, ts: Date.now() }

    if (event.shiftKey) {
      const targetElement = event.target instanceof Element ? event.target : null
      const blockElement = targetElement?.closest<HTMLElement>('[data-ca-block-path]')
      if (blockElement && onAddAnnotation) {
        const blockPath = blockElement.getAttribute('data-ca-block-path') || ''
        const blockType = blockElement.getAttribute('data-ca-block-type') || 'paragraph'
        const blockId = blockElement.getAttribute('data-ca-block-id') || undefined

        if (blockPath) {
          const alreadyExists = (annotations ?? []).some(annotation => {
            const blockSelector = annotation.target.selectors.find(s => s.type === 'block') as Extract<
              AnnotationV1['target']['selectors'][number],
              { type: 'block' }
            > | undefined
            if (!blockSelector) return false
            if (blockId && blockSelector.blockId) return blockSelector.blockId === blockId
            return blockSelector.path === blockPath
          })

          if (!alreadyExists) {
            const annotation: AnnotationV1 = {
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              schemaVersion: 1,
              createdAt: Date.now(),
              intent: 'highlight',
              body: [{ type: 'highlight' }],
              target: {
                source: {
                  sessionId: sessionId ?? '',
                  messageId,
                },
                selectors: [
                  {
                    type: 'block',
                    blockType: blockType as Extract<AnnotationV1['target']['selectors'][number], { type: 'block' }>['blockType'],
                    path: blockPath,
                    ...(blockId ? { blockId } : {}),
                  },
                ],
              },
              style: { color: 'yellow' },
            }
            onAddAnnotation(messageId, annotation)
          }
        }
      }
      selectionStartedInContentRef.current = false
      return
    }

    selectionStartedInContentRef.current = false
    showSelectionMenuFromCurrentSelection()
  }, [annotations, canAnnotate, messageId, onAddAnnotation, sessionId, showSelectionMenuFromCurrentSelection])

React.useEffect(() => {
    if (!canAnnotate) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        ts: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, showSelectionMenuFromCurrentSelection])

React.useEffect(() => {
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
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

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
return { handleSelectionPointerDown, handleTextSelection }
}
