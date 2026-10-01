import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { MissionRuntimeServiceOptions } from '../missions/MissionRuntimeService'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry
  /** Optional host bootstrap for certified, brokered Mission connector packs. */
  missionConnectorExecutorFactory?: MissionRuntimeServiceOptions['connectorExecutorFactory']
  /** Read-only/static connector qualification used by Mission dry-runs. */
  missionConnectorReadiness?: MissionRuntimeServiceOptions['connectorReadiness']
  /** Host-owned cost model used by Mission dry-runs. */
  missionPreflightCostEstimator?: MissionRuntimeServiceOptions['preflightCostEstimator']
  /** Read-only connection catalogue used by Mission dry-runs. */
  missionPreflightConnections?: MissionRuntimeServiceOptions['preflightConnections']
  /** Injectable app-level preference boundary for deterministic hosts and tests. */
  defaultThinkingLevelStore?: {
    get(): ThinkingLevel
    set(level: ThinkingLevel): boolean
  }
}
