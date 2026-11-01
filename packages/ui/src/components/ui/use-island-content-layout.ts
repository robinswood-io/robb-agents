import * as React from 'react';

import { type AnchorX, type AnchorY, type IslandMorphTarget, type IslandContentViewProps, IslandContentView, computeMorphDelta } from "./island-layout-primitives";

interface useIslandContentLayoutInput {
  children: React.ReactNode
  activeViewId: string
  shellRef: React.RefObject<HTMLDivElement | null>
  setMorphDelta: React.Dispatch<React.SetStateAction<{ x: number; y: number; scaleX: number; scaleY: number; } | null>>
  setIsMorphWarmReady: React.Dispatch<React.SetStateAction<boolean>>
  warmedViewIdsRef: React.RefObject<Set<string>>
  isVisible: boolean
  morphDelta: { x: number; y: number; scaleX: number; scaleY: number; } | null
}

export function useIslandContentLayout({
  children,
  activeViewId,
  shellRef,
  setMorphDelta,
  setIsMorphWarmReady,
  warmedViewIdsRef,
  isVisible,
  morphDelta,
}: useIslandContentLayoutInput) {
type ResolvedView = {
    id: string
    anchorX?: AnchorX
    anchorY?: AnchorY
    className?: string
    morphFrom?: IslandMorphTarget | null
    lockScroll?: boolean
    blockOutsideInteraction?: boolean
    node: React.ReactNode
  }

const contentViews = React.useMemo(() => {
    const entries: ResolvedView[] = []

    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return

      // Primary path: explicit IslandContentView marker component
      if (child.type === IslandContentView) {
        const props = child.props as IslandContentViewProps
        entries.push({
          id: props.id,
          ...(props.anchorX !== undefined ? { anchorX: props.anchorX } : {}),
          ...(props.anchorY !== undefined ? { anchorY: props.anchorY } : {}),
          ...(props.className !== undefined ? { className: props.className } : {}),
          ...(props.morphFrom !== undefined ? { morphFrom: props.morphFrom } : {}),
          ...(props.lockScroll !== undefined ? { lockScroll: props.lockScroll } : {}),
          ...(props.blockOutsideInteraction !== undefined ? { blockOutsideInteraction: props.blockOutsideInteraction } : {}),
          node: props.children,
        })
        return
      }

      // Flexible path: wrapped view components pass id/anchor props and render their own content.
      const props = child.props as Partial<IslandContentViewProps>
      if (typeof props.id === 'string') {
        entries.push({
          id: props.id,
          ...(props.anchorX !== undefined ? { anchorX: props.anchorX } : {}),
          ...(props.anchorY !== undefined ? { anchorY: props.anchorY } : {}),
          ...(props.className !== undefined ? { className: props.className } : {}),
          ...(props.morphFrom !== undefined ? { morphFrom: props.morphFrom } : {}),
          ...(props.lockScroll !== undefined ? { lockScroll: props.lockScroll } : {}),
          ...(props.blockOutsideInteraction !== undefined ? { blockOutsideInteraction: props.blockOutsideInteraction } : {}),
          node: child,
        })
      }
    })

    return entries
  }, [children])

const activeView = React.useMemo(
    () => contentViews.find((v) => v.id === activeViewId) ?? contentViews[0],
    [contentViews, activeViewId]
  )

const shouldMorph = Boolean(activeView?.morphFrom)

React.useLayoutEffect(() => {
    const target = activeView?.morphFrom
    const shell = shellRef.current

    if (!target || !shell) {
      setMorphDelta(null)
      return
    }

    const rect = shell.getBoundingClientRect()
    const layoutWidth = shell.offsetWidth
    const layoutHeight = shell.offsetHeight

    // Keep last valid delta during transient zero-size frames (mount/layout handoff).
    // This keeps enter/exit symmetry instead of collapsing to fallback scale only on show.
    if (rect.width <= 0 || rect.height <= 0 || layoutWidth <= 0 || layoutHeight <= 0) {
      return
    }

    setMorphDelta(computeMorphDelta(rect, target, layoutWidth, layoutHeight))
  }, [
    activeView?.id,
    activeView?.morphFrom?.x,
    activeView?.morphFrom?.y,
    activeView?.morphFrom?.width,
    activeView?.morphFrom?.height,
  ])

React.useEffect(() => {
    if (!activeView) {
      setIsMorphWarmReady(true)
      return
    }

    if (!shouldMorph) {
      setIsMorphWarmReady(true)
      warmedViewIdsRef.current.add(activeView.id)
      return
    }

    if (!isVisible) {
      setIsMorphWarmReady(false)
      return
    }

    if (warmedViewIdsRef.current.has(activeView.id)) {
      setIsMorphWarmReady(true)
      return
    }

    if (!morphDelta) {
      setIsMorphWarmReady(false)
      return
    }

    if (typeof window === 'undefined') {
      warmedViewIdsRef.current.add(activeView.id)
      setIsMorphWarmReady(true)
      return
    }

    setIsMorphWarmReady(false)

    let raf1 = 0
    let raf2 = 0

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        warmedViewIdsRef.current.add(activeView.id)
        setIsMorphWarmReady(true)
      })
    })

    return () => {
      window.cancelAnimationFrame(raf1)
      window.cancelAnimationFrame(raf2)
    }
  }, [activeView, shouldMorph, isVisible, morphDelta])
return { contentViews, activeView, shouldMorph }
}
