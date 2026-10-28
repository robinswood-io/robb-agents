import type { WsRpcClient, TransportConnectionState } from "../../../electron/src/transport/client";







export interface RemoteConnectionBadgeProps {
  client: WsRpcClient
  hostLabel: string
  offlineItemCount?: number | undefined
  onOpenOfflineWorkspace?: (() => void) | undefined
  onSignOut?: (() => Promise<void>) | undefined
}


export const dialogFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')


export function handleDialogKeyDown(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
  closeDialog: () => void,
) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeDialog()
    return
  }

  if (event.key !== 'Tab' || !dialog) return

  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
  ).filter((element) => element.getClientRects().length > 0)

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  if (!firstElement || !lastElement) return
  const activeElement = document.activeElement
  if (!dialog.contains(activeElement) || activeElement === dialog) {
    event.preventDefault()
    if (event.shiftKey) lastElement.focus()
    else firstElement.focus()
  } else if (event.shiftKey && activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}


export function dialogReturnTarget(fallback: HTMLElement | null): HTMLElement | null {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLElement && activeElement !== document.body
    ? activeElement
    : fallback
}


export function statusTone(status: TransportConnectionState['status']): string {
  if (status === 'connected') return 'border-emerald-500/20 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed' || status === 'disconnected') return 'border-destructive/20 bg-destructive/10 text-destructive'
  return 'border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300'
}
