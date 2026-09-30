/**
 * Wire protocol for the `client:browser:invoke` capability.
 *
 * The remote `RemoteBrowserPaneManager` packages an `IBrowserPaneManager`
 * method call into a `BrowserCapabilityRequest` and the local dispatcher
 * (Electron main IPC) executes it on the real `BrowserPaneManager`.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { BrowserMutationUrlPolicy } from '../handlers/browser-pane-manager-interface'

/** Legacy/observation protocol understood by every browser-capable desktop. */
export const BROWSER_CAPABILITY_VERSION = 1
/**
 * A policy-bearing page mutation is a distinct wire contract. Sending it as a
 * v2 request makes an older desktop reject the request instead of silently
 * ignoring a trailing policy argument and executing without the URL fence.
 */
export const BROWSER_MUTATION_POLICY_CAPABILITY_VERSION = 2

/**
 * Names map 1:1 to `IBrowserPaneManager` methods.
 * Positional `args` carry the method's arguments in declaration order.
 */
export type BrowserCapabilityMethod =
  // Lifecycle / instances
  | 'createForSession'
  | 'getOrCreateForSession'
  | 'focusBoundForSession'
  | 'destroyInstance'
  | 'destroyForSession'
  | 'getInstance'
  | 'listInstances'
  | 'bindSession'
  | 'unbindAllForSession'
  | 'setAgentControl'
  | 'clearAgentControl'
  | 'clearAgentControlForInstance'
  | 'clearVisualsForSession'
  | 'focus'
  | 'hide'
  // Navigation
  | 'navigate'
  | 'goBack'
  | 'goForward'
  // Interaction
  | 'getAccessibilitySnapshot'
  | 'clickElement'
  | 'clickAtCoordinates'
  | 'drag'
  | 'fillElement'
  | 'typeText'
  | 'selectOption'
  | 'sendKey'
  | 'scroll'
  | 'waitFor'
  | 'evaluate'
  // Clipboard
  | 'setClipboard'
  | 'getClipboard'
  // Capture / introspection
  | 'screenshot'
  | 'screenshotRegion'
  | 'getConsoleLogs'
  | 'getNetworkLogs'
  | 'windowResize'
  | 'getDownloads'
  | 'uploadFile'
  | 'detectSecurityChallenge'

export type BrowserPolicyMutationCapabilityMethod =
  | 'clickElement'
  | 'clickAtCoordinates'
  | 'drag'
  | 'fillElement'
  | 'typeText'
  | 'selectOption'
  | 'sendKey'
  | 'evaluate'
  | 'setClipboard'

interface BrowserCapabilityRequestBase {
  method: BrowserCapabilityMethod
  /** Positional args matching `IBrowserPaneManager[method]` without a mutation policy. */
  args: unknown[]
  /** Owning session — used for owner-key namespacing on the client dispatcher. */
  sessionId: string
  /** Owning workspace — combined with `sessionId` to form the owner-key prefix. */
  workspaceId: string
}

export interface BrowserCapabilityRequestV1 extends BrowserCapabilityRequestBase {
  v: 1
}

export interface BrowserPolicyMutationCapabilityRequestV2
  extends Omit<BrowserCapabilityRequestBase, 'method'> {
  v: 2
  method: BrowserPolicyMutationCapabilityMethod
  /** Required host policy, reapplied by Electron immediately before the effect. */
  mutationUrlPolicy: BrowserMutationUrlPolicy
}

export type BrowserCapabilityRequest =
  | BrowserCapabilityRequestV1
  | BrowserPolicyMutationCapabilityRequestV2

/**
 * Wire shape for `screenshot` / `screenshotRegion` results.
 *
 * The local `BrowserScreenshotResult` carries a Node `Buffer` for `imageBuffer`,
 * which doesn't survive structured cloning over WS. The dispatcher converts
 * `Buffer → Uint8Array` here, and `RemoteBrowserPaneManager` converts it back.
 */
export interface ScreenshotResultWire {
  imageFormat: 'png' | 'jpeg'
  imageBytes: Uint8Array
  metadata?: Record<string, unknown>
}
