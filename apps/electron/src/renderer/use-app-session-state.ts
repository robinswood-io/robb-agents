import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

import { useTheme } from '@/hooks/useTheme';
import { themeToCSS, type ThemeOverrides } from '@config/theme';
import { useAtomValue, useAtom } from 'jotai';
import type { Session, Workspace, PermissionRequest, CredentialRequest, LlmConnectionWithStatus, PermissionModeState } from '../shared/types';
import type { SessionDraft } from '@craft-agent/shared/config';
import type { SessionOptions } from './hooks/useSessionOptions';
import { defaultSessionOptions } from './hooks/useSessionOptions';

import { useUpdateChecker } from '@/hooks/useUpdateChecker';

import { windowWorkspaceIdAtom } from '@/atoms/sessions';
import { sourcesAtom } from '@/atoms/sources';
import { skillsAtom } from '@/atoms/skills';

import { type AppState } from "./app-runtime-helpers";

interface useAppSessionStateInput {
  updateSessionDirect: (sessionId: string, updater: (prev: Session | null) => Session | null) => void
  appState: AppState
}

export function useAppSessionState({
  updateSessionDirect,
  appState,
}: useAppSessionStateInput) {
const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

const [workspaces, setWorkspaces] = useState<Workspace[]>([])

const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)

const windowWorkspaceSlug = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.slug ?? windowWorkspaceId
  }, [windowWorkspaceId, workspaces])

const { initialSessionId, isFocusedMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      initialSessionId: params.get('sessionId'),
      isFocusedMode: params.get('focused') === 'true',
    }
  }, [])

const windowRemoteWorkspaceId = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.remoteServer?.remoteWorkspaceId ?? null
  }, [windowWorkspaceId, workspaces])

const [llmConnections, setLlmConnections] = useState<LlmConnectionWithStatus[]>([])

const [workspaceDefaultLlmConnection, setWorkspaceDefaultLlmConnection] = useState<string | undefined>()

const [defaultLlmConnectionSlug, setDefaultLlmConnectionSlug] = useState<string | undefined>()

const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.slug === defaultLlmConnectionSlug) ?? null
  }, [llmConnections, defaultLlmConnectionSlug])

const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)

const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest[]>>(new Map())

const [pendingCredentials, setPendingCredentials] = useState<Map<string, CredentialRequest[]>>(new Map())

const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())

const [sessionOptions, setSessionOptions] = useState<Map<string, SessionOptions>>(new Map())

const [appTheme, setAppTheme] = useState<ThemeOverrides | null>(null)

const [showResetDialog, setShowResetDialog] = useState(false)

const updateChecker = useUpdateChecker()

const [sessionsLoaded, setSessionsLoaded] = useState(false)

const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)

const [splashExiting, setSplashExiting] = useState(false)

const [splashHidden, setSplashHidden] = useState(false)

const [notificationsEnabled, setNotificationsEnabled] = useState(true)

const sources = useAtomValue(sourcesAtom)

const skills = useAtomValue(skillsAtom)

const isFullyReady = appState === 'ready' && sessionsLoaded

useEffect(() => {
    if (isFullyReady && !splashExiting) {
      setSplashExiting(true)
    }
  }, [isFullyReady, splashExiting])

const handleSplashExitComplete = useCallback(() => {
    setSplashHidden(true)
  }, [])

const { shikiTheme, isDark, theme } = useTheme({ appTheme })

useEffect(() => {
    const styleId = 'app-theme-override-vars'
    document.getElementById(styleId)?.remove()
    if (!appTheme) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `:root {\n  ${themeToCSS(theme, isDark)}\n}`
    document.head.appendChild(style)
    return () => style.remove()
  }, [appTheme, theme, isDark])

const sessionOptionsRef = useRef(sessionOptions)

useEffect(() => {
    sessionOptionsRef.current = sessionOptions
  }, [sessionOptions])

const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      next.set(sessionId, {
        ...current,
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
      return next
    })
  }, [])

const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])
return { setSessionOptions, reconcilePermissionModeState, setSessionLoadError, initialSessionId, setSessionsLoaded, windowWorkspaceId, windowRemoteWorkspaceId, setLlmConnections, setDefaultLlmConnectionSlug, setWorkspaceDefaultLlmConnection, setWindowWorkspaceId, setWorkspaces, setShowResetDialog, pendingPermissions, pendingCredentials, notificationsEnabled, setNotificationsEnabled, sessionDraftsRef, setAppTheme, setPendingPermissions, applyPermissionModeState, setPendingCredentials, setMenuNewChatTrigger, updateSessionById, windowWorkspaceSlug, skills, sources, sessionOptions, workspaces, llmConnections, workspaceDefaultLlmConnection, showResetDialog, splashHidden, shikiTheme, sessionsLoaded, splashExiting, handleSplashExitComplete, sessionLoadError, menuNewChatTrigger, isFocusedMode, isDark }
}
