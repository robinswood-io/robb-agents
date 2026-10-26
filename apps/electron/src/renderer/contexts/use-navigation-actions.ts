import { useCallback } from 'react';

import { parseRoute, parseRouteToNavigationState, buildRouteFromNavigationState, type ParsedRoute } from '../../shared/route-parser';
import { routes, type Route, type ViewRoute } from '../../shared/routes';
import { parsePermissionMode } from '@craft-agent/shared/agent/mode-types';
import { type NavigateOptions } from '../lib/navigate';
import { normalizeUserFacingSessionRoute } from './navigation-reconcile';

import * as storage from '@/lib/local-storage';
import type { Session, NavigationState, ContentBadge } from '../../shared/types';
import { isSessionsNavigation } from '../../shared/types';
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions';

import { updateFocusedPanelRouteAtom } from '@/atoms/panel-stack';

import { isUserFacingSession } from '@/utils/session-visibility';

interface useNavigationActionsInput {
  workspaceId: string | null
  onCreateSession: (workspaceId: string, options?: import("../../shared/types").CreateSessionOptions) => Promise<Session>
  autoDeleteEligibleSessionIdsRef: import("react").RefObject<Set<string>>
  updateSessionMeta: (sessionId: string, updates: Partial<SessionMeta>) => void
  pushPanel: (args_0: { route: ViewRoute; afterIndex?: number; targetLaneId?: import("@/atoms/panel-stack").PanelLaneId; intent?: import("@/atoms/panel-stack").OpenIntent; }) => void
  store: import("jotai").Store
  onInputChange: ((sessionId: string, value: string) => void) | undefined
  suppressAutoSelectRef: import("react").RefObject<boolean>
  isReady: boolean
  pendingNavigationRef: import("react").RefObject<ParsedRoute | null>
  resolveAutoSelection: (newState: NavigationState, options?: { skipAutoSelect?: boolean; }) => NavigationState
}

export function useNavigationActions({
  workspaceId,
  onCreateSession,
  autoDeleteEligibleSessionIdsRef,
  updateSessionMeta,
  pushPanel,
  store,
  onInputChange,
  suppressAutoSelectRef,
  isReady,
  pendingNavigationRef,
  resolveAutoSelection,
}: useNavigationActionsInput) {
const handleActionNavigation = useCallback(
    async (parsed: ParsedRoute, options?: { newPanel?: boolean; targetLaneId?: 'main' }) => {
      if (!workspaceId) return

      switch (parsed.name) {
        case 'new-session': {
          const createOptions: import('../../shared/types').CreateSessionOptions = {}
          if (parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (parsedMode) {
              createOptions.permissionMode = parsedMode
            }
          }
          if (parsed.params.workdir) {
            createOptions.workingDirectory = parsed.params.workdir as 'user_default' | 'none' | string
          }
          if (parsed.params.model) {
            createOptions.model = parsed.params.model
          }
          if (parsed.params.systemPrompt) {
            createOptions.systemPromptPreset = parsed.params.systemPrompt as 'default' | 'mini' | string
          }
          if (parsed.params.status) {
            createOptions.sessionStatus = parsed.params.status
          }
          if (parsed.params.label) {
            createOptions.labels = [parsed.params.label]
          }
          if (parsed.params.project) {
            createOptions.projectId = parsed.params.project
          }
          if (parsed.params.playbook) {
            createOptions.playbookSlug = parsed.params.playbook
          }
          const session = await onCreateSession(workspaceId, createOptions)
          autoDeleteEligibleSessionIdsRef.current.add(session.id)

          if (parsed.params.name) {
            await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: parsed.params.name })
          }

          if (parsed.params.status) {
            updateSessionMeta(session.id, { sessionStatus: parsed.params.status })
          }
          if (parsed.params.label) {
            updateSessionMeta(session.id, { labels: [parsed.params.label] })
          }

          if (parsed.params.status) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setSessionStatus', state: parsed.params.status })
          }
          if (parsed.params.label) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setLabels', labels: [parsed.params.label] })
          }

          // Determine navigation filter
          const filter: import('../../shared/types').SessionFilter =
            parsed.params.status ? { kind: 'state', stateId: parsed.params.status } :
            parsed.params.label ? { kind: 'label', labelId: parsed.params.label } :
            { kind: 'allSessions' }

          if (options?.newPanel) {
            // Open the new session in a new panel using lane-aware routing (pushPanel auto-focuses it)
            pushPanel({
              route: routes.view.allSessions(session.id) as ViewRoute,
              targetLaneId: options.targetLaneId,
              intent: 'explicit',
            })
          } else {
            // Navigate the focused panel to the new session
            const newState: NavigationState = {
              navigator: 'sessions',
              filter,
              details: { type: 'session', sessionId: session.id },
            }
            const route = buildRouteFromNavigationState(newState) as ViewRoute
            store.set(updateFocusedPanelRouteAtom, route)
            // Session selection sync handled by effect
          }

          // Parse badges from params
          let badges: ContentBadge[] | undefined
          if (parsed.params.badges) {
            try {
              badges = JSON.parse(parsed.params.badges) as ContentBadge[]
            } catch (e) {
              console.warn('[Navigation] Failed to parse badges param:', e)
            }
          }

          // Handle input: either auto-send or pre-fill
          if (parsed.params.input) {
            const shouldSend = parsed.params.send === 'true'
            if (shouldSend) {
              setTimeout(() => {
                window.electronAPI.sendMessage(
                  session.id,
                  parsed.params.input!,
                  undefined,
                  undefined,
                  badges ? { badges } : undefined
                )
              }, 100)
            } else if (onInputChange) {
              setTimeout(() => {
                onInputChange(session.id, parsed.params.input!)
              }, 100)
            }
          }
          break
        }

        case 'rename-session':
          if (parsed.id && parsed.params.name) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
          }
          break

        case 'delete-session':
          if (parsed.id) {
            await window.electronAPI.deleteSession(parsed.id)
          }
          break

        case 'flag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'flag' })
          }
          break

        case 'unflag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'unflag' })
          }
          break

        case 'oauth':
          if (parsed.id) {
            await window.electronAPI.performOAuth({ sourceSlug: parsed.id })
          }
          break

        case 'delete-source':
          if (parsed.id) {
            await window.electronAPI.deleteSource(workspaceId, parsed.id)
          }
          break

        case 'set-mode':
          if (parsed.id && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (!parsedMode) {
              console.warn('[Navigation] Invalid permission mode:', parsed.params.mode)
              break
            }
            await window.electronAPI.sessionCommand(
              parsed.id,
              { type: 'setPermissionMode', mode: parsedMode }
            )
          }
          break

        case 'copy':
          if (parsed.params.text) {
            await navigator.clipboard.writeText(parsed.params.text)
          }
          break

        default:
          console.warn('[Navigation] Unknown action:', parsed.name)
      }
    },
    [workspaceId, onCreateSession, onInputChange, pushPanel, store, updateSessionMeta, autoDeleteEligibleSessionIdsRef]
  )

const navigate = useCallback(
    async (route: Route, options?: NavigateOptions) => {
      // Reset auto-select suppression on any normal navigation
      if (!options?.skipAutoSelect) {
        suppressAutoSelectRef.current = false
      }

      const parsed = parseRoute(route)
      if (!parsed) {
        console.warn('[Navigation] Invalid route:', route)
        return
      }

      if (!isReady) {
        pendingNavigationRef.current = parsed
        return
      }

      // Handle actions (side effects)
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed, options)
        return
      }

      const normalizedRoute = normalizeUserFacingSessionRoute(
        route as ViewRoute,
        store.get(sessionMetaMapAtom),
      )
      const requestedState = parseRouteToNavigationState(route)
      const normalizedState = parseRouteToNavigationState(normalizedRoute)
      const removedInternalDetail = requestedState?.navigator === 'sessions'
        && !!requestedState.details
        && normalizedState?.navigator === 'sessions'
        && !normalizedState.details

      // For view routes with newPanel: push a panel using lane-aware routing.
      //
      // Important distinction:
      // - explicit opens (intent='explicit') can target a specific lane
      // - implicit navigation (updateFocusedPanelRouteAtom path) applies lock/fallback
      // This mirrors VS Code-style "locked group" behavior.
      if (options?.newPanel) {
        if (removedInternalDetail) suppressAutoSelectRef.current = true
        pushPanel({
          route: normalizedRoute,
          targetLaneId: options.targetLaneId,
          intent: 'explicit',
        })
        return
      }

      // Parse route to NavigationState. Bare `settings` produces `subpage: null` —
      // navigator-only view in compact mode, App-page fallback on desktop. We
      // intentionally do NOT auto-redirect to the last-visited subpage; doing so
      // would defeat the compact-mode drill-in UX.
      const newNavState = normalizedState

      // Suppress auto-select effect
      if (options?.skipAutoSelect || removedInternalDetail) {
        suppressAutoSelectRef.current = true
      }

      if (newNavState) {
        // Resolve auto-selection (pure — no side effects)
        const resolvedState = removedInternalDetail
          ? newNavState
          : resolveAutoSelection(newNavState, options)
        const finalRoute = buildRouteFromNavigationState(resolvedState) as ViewRoute

        // Persist last selected session for auto-select on next visit
        if (isSessionsNavigation(resolvedState) && resolvedState.details && workspaceId) {
          const meta = store.get(sessionMetaMapAtom).get(resolvedState.details.sessionId)
          if (meta && isUserFacingSession(meta)) {
            storage.set(storage.KEYS.lastSelectedSessionId, resolvedState.details.sessionId, workspaceId)
          }
        }

        // Update the focused panel's route (atom update is synchronous)
        // The panelStack atom subscription detects the route change and calls syncUrl(true)
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    },
    [isReady, handleActionNavigation, resolveAutoSelection, store, pushPanel, workspaceId, pendingNavigationRef, suppressAutoSelectRef]
  )
return { navigate, handleActionNavigation }
}
