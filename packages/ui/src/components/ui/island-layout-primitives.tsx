import * as React from 'react';






export type AnchorX = 'left' | 'center' | 'right'

export type AnchorY = 'top' | 'center' | 'bottom'

export type IslandDialogBehavior = 'none' | 'close' | 'back-or-close'


export type IslandMorphTarget = {
  x: number
  y: number
  width?: number
  height?: number
}


export interface IslandContentViewProps {
  id: string
  anchorX?: AnchorX
  anchorY?: AnchorY
  className?: string
  morphFrom?: IslandMorphTarget | null
  /** Locks document scrolling while this view is active and visible (dialog-like behavior). */
  lockScroll?: boolean
  /** Renders a full-viewport capture layer that blocks pointer interaction outside the island. Implies lockScroll. */
  blockOutsideInteraction?: boolean
  children: React.ReactNode
}


/**
 * Marker component for Island child views.
 *
 * Usage:
 * <Island activeViewId="compact">
 *   <IslandContentView id="compact">...</IslandContentView>
 *   <IslandContentView id="confirm">...</IslandContentView>
 * </Island>
 */
export function IslandContentView({ children }: IslandContentViewProps) {
  return <>{children}</>
}

IslandContentView.displayName = 'IslandContentView'


export interface IslandTransitionConfig {
  /** Master duration used by both shell and content animations */
  duration?: number
  /** Spring bounce for the shell layout animation */
  bounce?: number
  /** Enter/exit blur radius in px for content crossfade */
  blurPx?: number
  /** Direction in degrees for directional enter/exit offset (0 = from right, 90 = from bottom). */
  entryAngleDeg?: number
  /** Directional travel distance in pixels for enter/exit offset. */
  entryDistancePx?: number
  /** Start scale used when no morph target scale is available. */
  entryStartScale?: number
}


export interface IslandActiveViewSize {
  id: string
  width: number
  height: number
}


export interface IslandProps {
  activeViewId: string
  children: React.ReactNode
  className?: string
  radius?: number
  transitionConfig?: IslandTransitionConfig
  onActiveViewSizeChange?: (size: IslandActiveViewSize) => void
  /** Controls shell presence animation. Defaults to true for backward compatibility. */
  isVisible?: boolean
  /** Called after hide animation settles. Parent can unmount safely here. */
  onExitComplete?: () => void
  /** Calls onRequestClose when pointer-down happens outside the island shell while visible. */
  dismissOnPointerDownOutside?: boolean
  /** Consumer callback for close/dismiss requests (outside tap, escape, etc.). */
  onRequestClose?: () => void
  /** Consumer callback for back navigation requests. Return true when handled. */
  onRequestBack?: () => boolean
  /** Dialog semantics for Escape handling while visible. */
  dialogBehavior?: IslandDialogBehavior
  /** Locks document scrolling while the island is visible, regardless of active view-level lockScroll flags. */
  lockScrollWhileVisible?: boolean
  /** Force entry animation replay when this value changes (show(animated:true)-style control). */
  replayEntryKey?: string | number
  /** Controls whether visible transitions always run through an internal priming frame for deterministic entry replay. */
  replayOnVisible?: 'auto' | 'always'
  /** z-index for the blockOutsideInteraction overlay (portaled to body). Set to containerZIndex − 1. */
  overlayZIndex?: React.CSSProperties['zIndex']
}


export const DEFAULT_TRANSITION: Required<IslandTransitionConfig> = {
  duration: 0.4,
  bounce: 0.2,
  blurPx: 7,
  entryAngleDeg: 0,
  entryDistancePx: 0,
  entryStartScale: 0.25,
}


export const IslandAnimationContext = React.createContext<Required<IslandTransitionConfig>>(DEFAULT_TRANSITION)


export function useIslandAnimationConfig(): Required<IslandTransitionConfig> {
  return React.useContext(IslandAnimationContext)
}


export interface HandleIslandEscapeParams {
  dialogBehavior: IslandDialogBehavior
  onRequestBack?: () => boolean
  onRequestClose?: () => void
}


/**
 * Apply Island Escape behavior. Returns true when Escape was handled.
 */
export function handleIslandEscape({
  dialogBehavior,
  onRequestBack,
  onRequestClose,
}: HandleIslandEscapeParams): boolean {
  if (dialogBehavior === 'none') return false

  if (dialogBehavior === 'back-or-close' && onRequestBack?.()) {
    return true
  }

  if (!onRequestClose) return false
  onRequestClose()
  return true
}


export const CONTENT_EASE = [0.2, 0.8, 0.2, 1] as const


export let bodyScrollLockCount = 0

export let previousBodyOverflow: string | null = null

export let previousBodyTouchAction: string | null = null

export let removeGlobalScrollBlockers: (() => void) | null = null


export const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])


export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true

  const tag = target.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false

  const input = target as HTMLInputElement
  const type = (input.type || 'text').toLowerCase()
  const nonTextInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
  return !nonTextInputTypes.has(type)
}


export function installGlobalScrollBlockers(): () => void {
  if (typeof window === 'undefined') return () => {}

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
  }

  const onTouchMove = (event: TouchEvent) => {
    event.preventDefault()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(event.key)) return
    if (isEditableTarget(event.target)) return
    event.preventDefault()
  }

  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
  window.addEventListener('keydown', onKeyDown, { capture: true })

  return () => {
    window.removeEventListener('wheel', onWheel, true)
    window.removeEventListener('touchmove', onTouchMove, true)
    window.removeEventListener('keydown', onKeyDown, true)
  }
}


export function acquireBodyScrollLock(): void {
  if (typeof document === 'undefined') return

  if (bodyScrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow
    previousBodyTouchAction = document.body.style.touchAction
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'
    removeGlobalScrollBlockers = installGlobalScrollBlockers()
  }

  bodyScrollLockCount += 1
}


export function releaseBodyScrollLock(): void {
  if (typeof document === 'undefined' || bodyScrollLockCount <= 0) return

  bodyScrollLockCount -= 1

  if (bodyScrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow ?? ''
    document.body.style.touchAction = previousBodyTouchAction ?? ''
    previousBodyOverflow = null
    previousBodyTouchAction = null
    removeGlobalScrollBlockers?.()
    removeGlobalScrollBlockers = null
  }
}


export function resolveAlignClass(anchorX: AnchorX = 'center', anchorY: AnchorY = 'top'): string {
  const x = anchorX === 'left' ? 'justify-start' : anchorX === 'right' ? 'justify-end' : 'justify-center'
  const y = anchorY === 'top' ? 'items-start' : anchorY === 'bottom' ? 'items-end' : 'items-center'
  return `${x} ${y}`
}


export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(0.06, Math.min(4, value))
}


export function computeDirectionalOffset(angleDeg: number, distancePx: number): { x: number; y: number } {
  if (!Number.isFinite(distancePx) || distancePx === 0) return { x: 0, y: 0 }

  const angleRad = (Number.isFinite(angleDeg) ? angleDeg : 0) * (Math.PI / 180)
  return {
    x: Math.cos(angleRad) * distancePx,
    y: Math.sin(angleRad) * distancePx,
  }
}


export function computeMorphDelta(
  elementRect: DOMRect,
  target: IslandMorphTarget,
  elementLayoutWidth: number,
  elementLayoutHeight: number,
): {
  x: number
  y: number
  scaleX: number
  scaleY: number
} {
  const elementCenterX = elementRect.left + elementRect.width / 2
  const elementCenterY = elementRect.top + elementRect.height / 2
  const targetWidth = target.width ?? 1
  const targetHeight = target.height ?? 1
  const targetCenterX = target.x + targetWidth / 2
  const targetCenterY = target.y + targetHeight / 2

  const baseWidth = elementLayoutWidth > 0 ? elementLayoutWidth : elementRect.width
  const baseHeight = elementLayoutHeight > 0 ? elementLayoutHeight : elementRect.height

  return {
    x: targetCenterX - elementCenterX,
    y: targetCenterY - elementCenterY,
    scaleX: clampScale(target.width != null && baseWidth > 0 ? target.width / baseWidth : 0.16),
    scaleY: clampScale(target.height != null && baseHeight > 0 ? target.height / baseHeight : 0.16),
  }
}
