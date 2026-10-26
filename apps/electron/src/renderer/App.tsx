import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import "@/hooks/useTheme";
import "@config/theme";
import { useSetAtom, useStore } from 'jotai';
import "./hooks/useSessionOptions";
import "../shared/types";
import { useEventProcessor } from './event-processor';
import "@/components/app-shell/AppShell";
import "@/components/onboarding";
import "@/components/workspace";
import "@/components/ResetConfirmationDialog";
import "@/components/SplashScreen";
import "@craft-agent/ui";
import "@/context/FocusContext";
import "@/context/ModalContext";
import "@/context/DismissibleLayerContext";
import "@/hooks/useWindowCloseHandler";
import "@/hooks/useOnboarding";
import "@/hooks/useNotifications";
import "@/hooks/useSession";
import "@/hooks/useUpdateChecker";
import "@/contexts/NavigationContext";
import "./lib/navigate";
import "./lib/drafts";
import "./utils/text";
import "./lib/input-text";
import "./lib/reconnect-recovery";
import "./lib/session-load";
import "./lib/permission-mode-reconciliation";
import "./lib/session-created-hydration";
import "@craft-agent/shared/agent/thinking-levels";
import { initRendererPerf } from './lib/perf';
import { initializeSessionsAtom, addSessionAtom, removeSessionAtom, updateSessionAtom, replaceLoadedSessionAtom } from '@/atoms/sessions';
import "@/atoms/sources";
import "@/atoms/skills";
import "@/atoms/background-finished";
import "@/atoms/panel-stack";
import "@/utils/session";
import "@/utils/session-visibility";
import "@/utils/pending-request-queue";
import "@/atoms/session-auth-requests";
import "@/lib/mentions";
import "@craft-agent/ui";
import { useLinkInterceptor } from '@/hooks/useLinkInterceptor';
import "@/hooks/useTransportConnectionState";
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery';
import "@/components/app-shell/TransportConnectionBanner";
import { getFileManagerName } from '@/lib/platform';
import "@/lib/logger";
import "@/actions";
import { toast } from 'sonner';

import { useAppShellValues } from "./use-app-shell-values";





















































import { useAppWorkspaces } from "./use-app-workspaces";

import { useAppTransportStatus } from "./use-app-transport-status";

import { useAppPrompts } from "./use-app-prompts";

import { useAppDrafts } from "./use-app-drafts";

import { useAppMessageSending } from "./use-app-message-sending";

import { useAppSessionActions } from "./use-app-session-actions";

import { useAppListeners } from "./use-app-listeners";

import { useAppEventStream } from "./use-app-event-stream";

import { useAppWindowEvents } from "./use-app-window-events";

import { useAppOnboarding } from "./use-app-onboarding";

import { useAppSessionLoading } from "./use-app-session-loading";

import { useAppSessionState } from "./use-app-session-state";

import { AppMainView } from "./app-main-view";
import { type AppState } from "./app-runtime-helpers";

import type { SetupNeeds } from '../shared/types';

export default function App() {
  const { t } = useTranslation()

  // Initialize renderer perf tracking early (debug mode = running from source)
  // Uses useEffect with empty deps to run once on mount before any session switches
  useEffect(() => {
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App state: loading -> check auth -> onboarding or ready
  const [appState, setAppState] = useState<AppState>('loading')
  const [setupNeeds, setSetupNeeds] = useState<SetupNeeds | null>(null)

  // Per-session Jotai atom setters for isolated updates
  // NOTE: No sessionsAtom - we don't store a Session[] array anywhere to prevent memory leaks
  // Instead we use:
  // - sessionMetaMapAtom for lightweight listing
  // - sessionAtomFamily(id) for individual session data
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const store = useStore()
  const sessionCreatedHydrationsRef = useRef(new Map<string, Promise<void>>())

  // Helper to update a session by ID with partial fields
  // Uses per-session atom directly instead of updating an array
  const {
    setSessionOptions,
    reconcilePermissionModeState,
    setSessionLoadError,
    initialSessionId,
    setSessionsLoaded,
    windowWorkspaceId,
    windowRemoteWorkspaceId,
    setLlmConnections,
    setDefaultLlmConnectionSlug,
    setWorkspaceDefaultLlmConnection,
    setWindowWorkspaceId,
    setWorkspaces,
    setShowResetDialog,
    pendingPermissions,
    pendingCredentials,
    notificationsEnabled,
    setNotificationsEnabled,
    sessionDraftsRef,
    setAppTheme,
    setPendingPermissions,
    applyPermissionModeState,
    setPendingCredentials,
    setMenuNewChatTrigger,
    updateSessionById,
    windowWorkspaceSlug,
    skills,
    sources,
    sessionOptions,
    workspaces,
    llmConnections,
    workspaceDefaultLlmConnection,
    showResetDialog,
    splashHidden,
    shikiTheme,
    sessionsLoaded,
    splashExiting,
    handleSplashExitComplete,
    sessionLoadError,
    menuNewChatTrigger,
    isFocusedMode,
    isDark,
  } = useAppSessionState({
    updateSessionDirect, appState,
  })

  // Event processor hook - handles all agent events through pure functions
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  const {
    refreshSessionFromServer,
    loadSessionsFromServer,
    syncSessionOptionsFromSession,
    refreshSessionListMetadataFromServer,
  } = useAppSessionLoading({
    setSessionOptions, store,
    clearStreamingState, replaceLoadedSession,
    reconcilePermissionModeState, setSessionLoadError,
    initializeSessions, initialSessionId,
    setSessionsLoaded, windowWorkspaceId,
    windowRemoteWorkspaceId,
  })

  // Stale session watchdog — catches stuck sessions that the reconnect protocol misses
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500

  const {
    resolveDefaultConnectionSlug,
    refreshLlmConnections,
    onboarding,
    handleReauthLogin,
    handleReauthReset,
  } = useAppOnboarding({
    setLlmConnections, setDefaultLlmConnectionSlug,
    windowWorkspaceId, setWorkspaceDefaultLlmConnection,
    setWindowWorkspaceId, setWorkspaces,
    setAppState, setupNeeds,
    setSetupNeeds, t,
    setShowResetDialog,
  })

  // Check auth state and get window's workspace ID on mount
  const {
    showSessionNotification,
    sessionSelection,
    setSession,
  } = useAppWindowEvents({
    setWindowWorkspaceId, setSetupNeeds,
    setAppState, store,
    pendingPermissions, pendingCredentials,
    t, windowWorkspaceId,
    notificationsEnabled, appState,
    setWorkspaces, setNotificationsEnabled,
    loadSessionsFromServer, setLlmConnections,
    setDefaultLlmConnectionSlug, resolveDefaultConnectionSlug,
    sessionDraftsRef, setAppTheme,
    refreshLlmConnections,
  })

  // Listen for session events - uses centralized event processor for consistent state transitions
  //
  // SOURCE OF TRUTH LOGIC:
  // - During streaming (atom.isProcessing = true): Atom is source of truth
  //   All events read from and write to atom. This preserves streaming data.
  // - When not streaming: React state is source of truth
  //   Events read/write React state, which syncs to atoms via useEffect.
  // - Handoff events (complete, error, etc.): End streaming, sync atom → React state
  //
  // This is simpler and more robust than checking event types - we just ask
  // "is this session currently streaming?" and route accordingly.
  useAppEventStream({
    setPendingPermissions, store,
    showSessionNotification, applyPermissionModeState,
    setSessionOptions, reconcilePermissionModeState,
    setPendingCredentials, sessionDraftsRef,
    handleInputChange: (...args) => handleInputChange(...args), windowWorkspaceId,
    sessionCreatedHydrationsRef, replaceLoadedSession,
    addSession, syncSessionOptionsFromSession,
    refreshSessionListMetadataFromServer, removeSession,
    trackSessionActivity, processAgentEvent,
    updateSessionDirect,
  })

  // Transport reconnect recovery — refresh session metadata plus active/processing
  // session content after stale reconnects.
  useAppListeners({
    refreshSessionListMetadataFromServer, sessionSelection,
    store, refreshSessionFromServer,
    setMenuNewChatTrigger, handleOpenSettings: (...args) => handleOpenSettings(...args),
  })

  const {
    handleCreateSession,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleAutoDeleteEmptySession,
  } = useAppSessionActions({
    addSession, syncSessionOptionsFromSession,
    store, removeSession,
    updateSessionById, windowWorkspaceId,
  })

  const {
    handleSendMessage,
    handleSessionOptionsChange,
  } = useAppMessageSending({
    store, updateSessionById,
    windowWorkspaceSlug, skills,
    sources, setSessionOptions,
  })

  // Handle input draft changes per session with debounced persistence
  const {
    handleInputChange,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    handleAttachmentsChange,
  } = useAppDrafts({
    sessionDraftsRef, DRAFT_SAVE_DEBOUNCE_MS,
  })

  // Open new chat - creates session and selects it
  // Used by components via AppShellContext and for programmatic navigation
  const {
    handleRespondToPermission,
    handleRespondToCredential,
    openNewChat,
  } = useAppPrompts({
    windowWorkspaceId, handleCreateSession,
    handleInputChange, setPendingPermissions,
    setPendingCredentials,
  })

  // Centralized link interceptor: classifies file types and decides whether to
  // show an in-app preview overlay or open externally. Replaces the old
  // handleOpenFile/handleOpenUrl that always opened in external apps.
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        // The blocked-URL classifier already explains WHY and (for file:)
        // points the user at preview blocks. Don't append the generic
        // "use Open File instead" hint when the message already carries
        // that guidance.
        const hasRichGuidance = /URL blocked/.test(message)
        const tail = hasRichGuidance ? '' : '. If this is a local path, use Open File instead.'
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}${tail}`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const {
    showTransportConnectionBanner,
    connectionState,
    handleReconnectTransport,
  } = useAppTransportStatus({
    t,
  })

  const handleOpenFile = linkInterceptor.handleOpenFile
  const {
    handleOpenSettings,
    handleOpenUrl,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    executeReset,
    handleSwitchWorkspaceBySlug,
  } = useAppWorkspaces({
    linkInterceptor, t,
    setShowResetDialog, initializeSessions,
    setWorkspaces, setWindowWorkspaceId,
    setSetupNeeds, onboarding,
    setAppState, windowWorkspaceId,
    setSession, setPendingPermissions,
    setPendingCredentials, setSessionOptions,
    sessionDraftsRef, store,
    workspaces,
  })

  // Build context value for AppShell component
  // This is memoized to prevent unnecessary re-renders
  // IMPORTANT: Must be before early returns to maintain consistent hook order
  const {
    platformActions,
    appShellContextValue,
  } = useAppShellValues({
    workspaces, windowWorkspaceId,
    windowWorkspaceSlug, llmConnections,
    workspaceDefaultLlmConnection, refreshLlmConnections,
    pendingPermissions, pendingCredentials,
    getDraft, getDraftAttachmentRefs,
    hydrateDraftAttachments, sessionOptions,
    handleCreateSession, handleSendMessage,
    handleRenameSession, handleFlagSession,
    handleUnflagSession, handleArchiveSession,
    handleUnarchiveSession, handleMarkSessionRead,
    handleMarkSessionUnread, handleSetActiveViewingSession,
    handleSessionStatusChange, handleDeleteSession,
    handleRespondToPermission, handleRespondToCredential,
    handleOpenFile, handleOpenUrl,
    handleSelectWorkspace, handleRefreshWorkspaces,
    handleOpenSettings, handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences, handleReset,
    handleSessionOptionsChange, handleInputChange,
    handleAttachmentsChange, openNewChat,
    linkInterceptor,
  })

  // Loading state - show splash screen
  return (
    <AppMainView
      appState={appState} handleReauthLogin={handleReauthLogin} handleReauthReset={handleReauthReset}
      showResetDialog={showResetDialog} executeReset={executeReset} setShowResetDialog={setShowResetDialog}
      onboarding={onboarding} setWindowWorkspaceId={setWindowWorkspaceId} setAppState={setAppState}
      splashHidden={splashHidden} platformActions={platformActions} shikiTheme={shikiTheme}
      windowWorkspaceId={windowWorkspaceId} windowWorkspaceSlug={windowWorkspaceSlug} handleSwitchWorkspaceBySlug={handleSwitchWorkspaceBySlug}
      handleCreateSession={handleCreateSession} handleInputChange={handleInputChange} getDraft={getDraft}
      handleAutoDeleteEmptySession={handleAutoDeleteEmptySession} sessionsLoaded={sessionsLoaded} windowRemoteWorkspaceId={windowRemoteWorkspaceId}
      splashExiting={splashExiting} handleSplashExitComplete={handleSplashExitComplete} showTransportConnectionBanner={showTransportConnectionBanner}
      connectionState={connectionState} handleReconnectTransport={handleReconnectTransport} sessionLoadError={sessionLoadError}
      loadSessionsFromServer={loadSessionsFromServer} appShellContextValue={appShellContextValue} menuNewChatTrigger={menuNewChatTrigger}
      isFocusedMode={isFocusedMode} linkInterceptor={linkInterceptor} isDark={isDark}
    />
  )
}
