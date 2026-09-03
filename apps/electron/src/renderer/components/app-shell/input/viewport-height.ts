interface VisualViewportLike {
  height: number
  scale: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

interface WindowViewportLike {
  innerHeight: number
  visualViewport?: VisualViewportLike | null
  addEventListener(type: 'resize', listener: () => void): void
  removeEventListener(type: 'resize', listener: () => void): void
}

/**
 * Return the height that fixed app UI can actually occupy. VisualViewport is
 * authoritative while the virtual keyboard is open, but must be ignored
 * during pinch zoom so page zoom does not reflow the application itself.
 */
export function readUsableViewportHeight(
  target: WindowViewportLike = window,
): number {
  const layoutHeight = Number.isFinite(target.innerHeight)
    ? Math.max(0, target.innerHeight)
    : 0
  const viewport = target.visualViewport
  if (
    !viewport
    || viewport.scale > 1.01
    || !Number.isFinite(viewport.height)
    || viewport.height <= 0
  ) return layoutHeight
  return Math.min(layoutHeight, viewport.height)
}

export function subscribeToViewportHeight(
  listener: (height: number) => void,
  target: WindowViewportLike = window,
): () => void {
  const update = () => listener(readUsableViewportHeight(target))
  update()
  target.addEventListener('resize', update)
  target.visualViewport?.addEventListener('resize', update)
  target.visualViewport?.addEventListener('scroll', update)
  return () => {
    target.removeEventListener('resize', update)
    target.visualViewport?.removeEventListener('resize', update)
    target.visualViewport?.removeEventListener('scroll', update)
  }
}
