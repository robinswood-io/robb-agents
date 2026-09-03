import {
  readUsableViewportHeight,
  subscribeToViewportHeight,
} from '@/components/app-shell/input/viewport-height'

/** Synchronize the PWA shell with the portion of the screen not covered by the keyboard. */
export function installWebViewportSync(
  targetWindow: Window = window,
  targetDocument: Document = document,
): () => void {
  return subscribeToViewportHeight((height) => {
    targetDocument.documentElement.style.setProperty(
      '--webui-viewport-height',
      `${Math.round(height)}px`,
    )
  }, targetWindow)
}

export { readUsableViewportHeight }
