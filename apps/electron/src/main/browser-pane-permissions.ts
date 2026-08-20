const BROWSER_PANE_ALLOWED_PERMISSIONS = new Set<string>([
  'fullscreen',
  'pointerLock',
])

/**
 * Browser capabilities that an explicitly autonomous Execute session may need
 * while completing a web flow. This remains deliberately narrower than
 * Chromium's full permission surface: payment, device, local-network, install,
 * screen-capture, and clipboard permissions stay denied.
 */
const BROWSER_PANE_AUTONOMOUS_PERMISSIONS = new Set<string>([
  'background-fetch',
  'geolocation',
  'media',
  'notifications',
  'persistent-storage',
  'sensors',
  'storage-access',
  'top-level-storage-access',
])

export interface BrowserPanePermissionContext {
  /** The browser must currently be controlled by the session, not a manual tab. */
  agentControlled: boolean
  permissionMode?: string
  externalActionPolicy?: string
  /** Origin of the frame asking Chromium for the permission. */
  requestingOrigin?: string
  /** Current top-level document URL for the owned browser instance. */
  topLevelUrl?: string
}

/**
 * A secure web context is the minimum origin boundary for autonomous browser
 * permissions. Opaque, local-file, data, and clear-text origins fail closed.
 */
export function isSecureBrowserPermissionOrigin(value: string | undefined): boolean {
  if (!value) return false

  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
  } catch {
    return false
  }
}

export function isBrowserPanePermissionAllowed(
  permission: string,
  context?: BrowserPanePermissionContext,
): boolean {
  if (BROWSER_PANE_ALLOWED_PERMISSIONS.has(permission)) return true
  if (!BROWSER_PANE_AUTONOMOUS_PERMISSIONS.has(permission)) return false

  return context?.agentControlled === true
    && context.permissionMode === 'allow-all'
    && context.externalActionPolicy === 'allow-in-execute'
    && isSecureBrowserPermissionOrigin(context.requestingOrigin)
    && isSecureBrowserPermissionOrigin(context.topLevelUrl)
}
