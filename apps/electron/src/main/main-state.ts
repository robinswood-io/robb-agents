import type { WindowManager } from './window-manager'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import type { BrowserPaneManager } from './browser-pane-manager'
import type { OAuthFlowStore } from '@craft-agent/shared/auth'
import type { EventSink } from '@craft-agent/server-core/transport'
import type { WebuiHandler } from '@craft-agent/server-core/webui'
import type { MessagingBootstrapHandle } from '@craft-agent/messaging-gateway'

// Runtime references shared by startup, deep links, and shutdown.
export const mainState: {
  windowManager: WindowManager | null
  sessionManager: SessionManager | null
  browserPaneManager: BrowserPaneManager | null
  oauthFlowStore: OAuthFlowStore | null
  moduleSink: EventSink | null
  moduleClientResolver: ((webContentsId: number) => string | undefined) | null
  embeddedWebuiHandler: WebuiHandler | null
  messagingHandle: MessagingBootstrapHandle | null
  pendingDeepLink: string | null
} = {
  windowManager: null, sessionManager: null, browserPaneManager: null,
  oauthFlowStore: null, moduleSink: null, moduleClientResolver: null,
  embeddedWebuiHandler: null, messagingHandle: null, pendingDeepLink: null,
}
