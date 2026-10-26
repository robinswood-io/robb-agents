import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../../lib/utils';
import { getDismissibleLayerBridge } from '../../lib/dismissible-layer-bridge';
import { type IslandProps, DEFAULT_TRANSITION, IslandAnimationContext, handleIslandEscape, CONTENT_EASE, acquireBodyScrollLock, releaseBodyScrollLock, resolveAlignClass, clampScale, computeDirectionalOffset } from "./island-layout-primitives";
export { type AnchorX, type AnchorY, type IslandDialogBehavior, type IslandMorphTarget, type IslandContentViewProps, IslandContentView, type IslandTransitionConfig, type IslandActiveViewSize, type IslandProps, useIslandAnimationConfig, type HandleIslandEscapeParams, handleIslandEscape } from "./island-layout-primitives";

import { useIslandContentLayout } from "./use-island-content-layout";









/**
 * Animated shell that morphs between registered IslandContentView children.
 *
 * - Outer shell: layout spring + optional morph from/to target
 * - Inner content: parallel enter/exit crossfade + blur
 */
export function Island({
  activeViewId,
  children,
  className,
  radius = 12,
  transitionConfig,
  onActiveViewSizeChange,
  isVisible = true,
  onExitComplete,
  dismissOnPointerDownOutside = false,
  onRequestClose,
  onRequestBack,
  dialogBehavior = 'back-or-close',
  lockScrollWhileVisible = false,
  replayEntryKey,
  replayOnVisible = 'auto',
  overlayZIndex,
}: IslandProps) {
  const shellRef = React.useRef<HTMLDivElement | null>(null)
  const activeViewRef = React.useRef<HTMLDivElement | null>(null)
  const layerIdRef = React.useRef(`island-${Math.random().toString(36).slice(2)}`)
  const lastSizeRef = React.useRef<{ id: string; width: number; height: number } | null>(null)
  const [isTransitionSettling, setIsTransitionSettling] = React.useState(true)
  const [morphDelta, setMorphDelta] = React.useState<{ x: number; y: number; scaleX: number; scaleY: number } | null>(null)
  const warmedViewIdsRef = React.useRef<Set<string>>(new Set())
  const [isMorphWarmReady, setIsMorphWarmReady] = React.useState(true)
  const shouldPrimeInitialVisibleReplay = replayOnVisible === 'always' && isVisible
  const [isVisibilityPrimed, setIsVisibilityPrimed] = React.useState(() => !shouldPrimeInitialVisibleReplay)
  const prevVisibilityForReplayRef = React.useRef<boolean>(shouldPrimeInitialVisibleReplay ? false : isVisible)
  const prevReplayEntryKeyRef = React.useRef<string | number | undefined>(replayEntryKey)
  const hasRenderedVisibleRef = React.useRef<boolean>(false)
  const spawnHiddenPoseRef = React.useRef<{ opacity: number; x: number; y: number; scaleX: number; scaleY: number } | null>(null)
  const prevIsVisibleRef = React.useRef<boolean>(isVisible)
  const cfg = React.useMemo(
    () => ({ ...DEFAULT_TRANSITION, ...(transitionConfig ?? {}) }),
    [transitionConfig]
  )

  const layoutTransition = React.useMemo(
    () => ({ type: 'spring' as const, duration: cfg.duration, bounce: cfg.bounce }),
    [cfg.duration, cfg.bounce]
  )

  const contentTransition = React.useMemo(
    () => ({ duration: cfg.duration, ease: CONTENT_EASE }),
    [cfg.duration]
  )
  const { contentViews, activeView, shouldMorph } = useIslandContentLayout({
    children,
    activeViewId,
    shellRef,
    setMorphDelta,
    setIsMorphWarmReady,
    warmedViewIdsRef,
    isVisible,
    morphDelta,
  })

  React.useEffect(() => {
    if (!activeView) return
    setIsTransitionSettling(true)
  }, [activeView?.id])

  React.useEffect(() => {
    if (replayOnVisible !== 'always') {
      setIsVisibilityPrimed(true)
      prevVisibilityForReplayRef.current = isVisible
      prevReplayEntryKeyRef.current = replayEntryKey
      return
    }

    const becameVisible = !prevVisibilityForReplayRef.current && isVisible
    const replayKeyChangedWhileVisible = isVisible && prevReplayEntryKeyRef.current !== replayEntryKey

    prevVisibilityForReplayRef.current = isVisible
    prevReplayEntryKeyRef.current = replayEntryKey

    if (!isVisible) {
      setIsVisibilityPrimed(true)
      return
    }

    // If we're already unprimed (e.g. StrictMode cancelled the first RAF),
    // keep scheduling a priming RAF until we reach the visible state.
    const needsPriming = becameVisible || replayKeyChangedWhileVisible || !isVisibilityPrimed
    if (!needsPriming) {
      return
    }

    setIsVisibilityPrimed(false)

    if (typeof window === 'undefined') {
      setIsVisibilityPrimed(true)
      return
    }

    const raf = window.requestAnimationFrame(() => {
      setIsVisibilityPrimed(true)
    })

    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [isVisible, replayEntryKey, replayOnVisible, isVisibilityPrimed])

  const shouldLockScroll = (activeView?.lockScroll ?? false) || (activeView?.blockOutsideInteraction ?? false) || lockScrollWhileVisible
  const isDialogMode = dialogBehavior !== 'none'

  React.useEffect(() => {
    if (!isDialogMode || !isVisible) return

    const bridge = getDismissibleLayerBridge()
    if (!bridge) return

    return bridge.registerLayer({
      id: layerIdRef.current,
      type: 'island',
      priority: 200,
      close: () => {
        onRequestClose?.()
      },
      canBack: dialogBehavior === 'back-or-close'
        ? () => Boolean(onRequestBack)
        : undefined,
      back: dialogBehavior === 'back-or-close'
        ? () => handleIslandEscape({ dialogBehavior, onRequestBack, onRequestClose })
        : undefined,
    })
  }, [isDialogMode, isVisible, dialogBehavior, onRequestBack, onRequestClose])

  React.useEffect(() => {
    if (!shouldLockScroll || !isVisible) return

    acquireBodyScrollLock()
    return () => {
      releaseBodyScrollLock()
    }
  }, [activeView?.id, shouldLockScroll, isVisible])

  React.useEffect(() => {
    if (!(shouldLockScroll || isDialogMode) || !isVisible) return
    shellRef.current?.focus()
  }, [shouldLockScroll, isDialogMode, isVisible, activeView?.id])

  React.useEffect(() => {
    if (!isVisible || dialogBehavior === 'none') return
    if (typeof window === 'undefined') return

    const bridge = getDismissibleLayerBridge()
    if (bridge) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return

      const handled = handleIslandEscape({
        dialogBehavior,
        onRequestBack,
        onRequestClose,
      })

      if (!handled) return

      event.preventDefault()
      event.stopPropagation()
    }

    // Bubble phase so nested controls can consume Escape first.
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isVisible, dialogBehavior, onRequestBack, onRequestClose])

  React.useEffect(() => {
    if (!dismissOnPointerDownOutside || !isVisible || !onRequestClose) return
    if (typeof window === 'undefined') return

    const onPointerDown = (event: PointerEvent) => {
      const shell = shellRef.current
      const target = event.target as Node | null
      if (!shell || !target) return
      if (shell.contains(target)) return
      onRequestClose()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [dismissOnPointerDownOutside, isVisible, onRequestClose])

  React.useEffect(() => {
    if (!isTransitionSettling) return

    if (typeof window === 'undefined') {
      setIsTransitionSettling(false)
      return
    }

    const timeout = window.setTimeout(() => {
      setIsTransitionSettling(false)
    }, Math.max(0, cfg.duration * 1000 + 80))

    return () => {
      window.clearTimeout(timeout)
    }
  }, [isTransitionSettling, cfg.duration])

  React.useEffect(() => {
    if (isVisible || !onExitComplete) return

    if (typeof window === 'undefined') {
      onExitComplete()
      return
    }

    const timeout = window.setTimeout(() => {
      onExitComplete()
    }, Math.max(120, cfg.duration * 1000 + 40))

    return () => {
      window.clearTimeout(timeout)
    }
  }, [isVisible, onExitComplete, cfg.duration])

  React.useEffect(() => {
    if (!activeView || !onActiveViewSizeChange) return

    const element = activeViewRef.current
    if (!element) return

    const emitIfChanged = () => {
      if (isTransitionSettling) return

      const rect = element.getBoundingClientRect()
      const next = {
        id: activeView.id,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }

      if (next.width <= 0 || next.height <= 0) return

      const prev = lastSizeRef.current
      if (prev && prev.id === next.id && prev.width === next.width && prev.height === next.height) return

      lastSizeRef.current = next
      onActiveViewSizeChange(next)
    }

    emitIfChanged()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      emitIfChanged()
    })

    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [activeView, onActiveViewSizeChange, isTransitionSettling])

  if (!activeView) return null

  const FALLBACK_HIDDEN_SCALE = clampScale(cfg.entryStartScale)
  const isPreShowWarmup = shouldMorph && isVisible && !isMorphWarmReady
  const directionalOffset = React.useMemo(
    () => computeDirectionalOffset(cfg.entryAngleDeg, cfg.entryDistancePx),
    [cfg.entryAngleDeg, cfg.entryDistancePx]
  )

  const hasUsableMorphDelta = React.useMemo(() => {
    if (!shouldMorph || !morphDelta) return false
    if (typeof window === 'undefined') return true

    // Guard against transiently bad frame calculations on first open.
    // If delta is implausibly large, prefer in-place scale morph for that frame.
    const maxX = window.innerWidth * 0.75
    const maxY = window.innerHeight * 0.75
    return Math.abs(morphDelta.x) <= maxX && Math.abs(morphDelta.y) <= maxY
  }, [shouldMorph, morphDelta])

  const hasEntryTranslation = Math.abs(cfg.entryDistancePx) > 0.0001
  const hasEntryScale = transitionConfig?.entryStartScale != null && Math.abs(cfg.entryStartScale - 1) > 0.0001
  const hasReplayEntryRequest = replayEntryKey != null
  const shouldAnimateFromHiddenOnMount = shouldMorph || hasEntryTranslation || hasEntryScale || hasReplayEntryRequest
  const shouldUseConfiguredStartScale = transitionConfig?.entryStartScale != null

  const hiddenPose = {
    opacity: 0,
    x: (hasUsableMorphDelta ? (morphDelta?.x ?? 0) : 0) + directionalOffset.x,
    y: (hasUsableMorphDelta ? (morphDelta?.y ?? 0) : 0) + directionalOffset.y,
    scaleX: (hasUsableMorphDelta && !shouldUseConfiguredStartScale)
      ? (morphDelta?.scaleX ?? FALLBACK_HIDDEN_SCALE)
      : FALLBACK_HIDDEN_SCALE,
    scaleY: (hasUsableMorphDelta && !shouldUseConfiguredStartScale)
      ? (morphDelta?.scaleY ?? FALLBACK_HIDDEN_SCALE)
      : FALLBACK_HIDDEN_SCALE,
  }

  const visiblePose = {
    opacity: 1,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
  }

  React.useEffect(() => {
    const isFirstVisibleFrame = isVisible && spawnHiddenPoseRef.current == null
    const becameVisible = !prevIsVisibleRef.current && isVisible
    if (isFirstVisibleFrame || becameVisible) {
      // Remember the original spawn rectangle/pose so hide can always animate back to it
      // even if content/view dimensions changed while the island was open.
      spawnHiddenPoseRef.current = { ...hiddenPose }
    }

    if (!isVisible) {
      // Keep last captured spawn pose for exit animation.
      prevIsVisibleRef.current = false
      return
    }

    prevIsVisibleRef.current = true
  }, [isVisible, hiddenPose])

  const shouldHideForWarmup = shouldMorph && isVisible && !isMorphWarmReady && !hasRenderedVisibleRef.current
  const shouldHideForReplayPriming = replayOnVisible === 'always' && isVisible && !isVisibilityPrimed
  const effectiveVisible = isVisible && !shouldHideForWarmup && !shouldHideForReplayPriming
  const shouldBlockOutside = (activeView?.blockOutsideInteraction ?? false) && effectiveVisible
  const exitHiddenPose = spawnHiddenPoseRef.current ?? hiddenPose

  React.useEffect(() => {
    if (effectiveVisible) {
      hasRenderedVisibleRef.current = true
      return
    }

    if (!isVisible) {
      hasRenderedVisibleRef.current = false
    }
  }, [effectiveVisible, isVisible])

  const shellTransition = React.useMemo(
    () => (isPreShowWarmup
      ? ({ type: 'tween' as const, duration: 0 })
      : layoutTransition),
    [isPreShowWarmup, layoutTransition]
  )

  return (
    <IslandAnimationContext.Provider value={cfg}>
      {shouldBlockOutside && typeof document !== 'undefined' && ReactDOM.createPortal(
        <div
          data-ca-island-blocker="true"
          className="fixed inset-0"
          style={overlayZIndex != null ? { zIndex: overlayZIndex } : undefined}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerUp={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleIslandEscape({ dialogBehavior, onRequestBack, onRequestClose })
          }}
        />,
        document.body
      )}
      <motion.div
        key={replayEntryKey != null ? `replay:${String(replayEntryKey)}` : 'replay:default'}
        ref={shellRef}
        layout
        initial={shouldAnimateFromHiddenOnMount ? hiddenPose : false}
        animate={effectiveVisible ? visiblePose : exitHiddenPose}
        transition={shellTransition}
        style={{ borderRadius: radius, transformOrigin: '50% 50%' }}
        role={isDialogMode ? 'dialog' : undefined}
        aria-modal={isDialogMode ? true : undefined}
        tabIndex={isDialogMode ? -1 : undefined}
        data-ca-island-dialog={isDialogMode ? 'true' : undefined}
        data-state={effectiveVisible ? 'open' : 'closed'}
        className={cn('mx-auto w-fit overflow-hidden border border-border/50 bg-background shadow-strong', className)}
      >
        <div className="relative">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={activeView.id}
              layout
              initial={{ opacity: 0, filter: `blur(${cfg.blurPx}px)` }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: `blur(${cfg.blurPx}px)` }}
              transition={contentTransition}
              onAnimationComplete={() => setIsTransitionSettling(false)}
              onLayoutAnimationComplete={() => setIsTransitionSettling(false)}
            >
              <div
                ref={activeViewRef}
                className={cn('flex', resolveAlignClass(activeView.anchorX, activeView.anchorY), activeView.className)}
              >
                {activeView.node}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </IslandAnimationContext.Provider>
  )
}
