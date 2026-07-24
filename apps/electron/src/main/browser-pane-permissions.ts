const BROWSER_PANE_ALLOWED_PERMISSIONS = new Set<string>([
  'fullscreen',
  'pointerLock',
])

export function isBrowserPanePermissionAllowed(permission: string): boolean {
  return BROWSER_PANE_ALLOWED_PERMISSIONS.has(permission)
}
