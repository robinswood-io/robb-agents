import React from 'react';

import type { Session } from '../shared/types';

import { AppShell } from '@/components/app-shell/AppShell';
import type { AppShellContextType } from '@/context/AppShellContext';
import { OnboardingWizard, ReauthScreen } from '@/components/onboarding';
import { WorkspacePicker } from '@/components/workspace';
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog';
import { SplashScreen } from '@/components/SplashScreen';
import { TooltipProvider } from '@craft-agent/ui';
import { FocusProvider } from '@/context/FocusContext';
import { ModalProvider } from '@/context/ModalContext';
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext';

import { useOnboarding } from '@/hooks/useOnboarding';

import { NavigationProvider } from '@/contexts/NavigationContext';

import { ShikiThemeProvider, PlatformProvider } from '@craft-agent/ui';
import { useLinkInterceptor } from '@/hooks/useLinkInterceptor';

import { TransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner';

import { ActionRegistryProvider } from '@/actions';

import { type AppState } from "./app-runtime-helpers";
import { SessionLoadErrorScreen, WindowCloseHandler, FilePreviewRenderer } from "./app-status-views";

interface AppMainViewProps {
  appState: AppState
  handleReauthLogin: () => Promise<void>
  handleReauthReset: () => void
  showResetDialog: boolean
  executeReset: () => Promise<void>
  setShowResetDialog: React.Dispatch<React.SetStateAction<boolean>>
  onboarding: ReturnType<typeof useOnboarding>
  setWindowWorkspaceId: (args_0: string | ((prev: string | null) => string | null) | null) => void
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
  splashHidden: boolean
  platformActions: { onOpenFile: (path: string) => void; onOpenUrl: (url: string) => void; onOpenFileExternal: (path: string) => void; onReadFile: (path: string) => Promise<string>; onReadFileDataUrl: (path: string) => Promise<string>; onReadFileBinary: (path: string) => Promise<Uint8Array<ArrayBufferLike>>; onRevealInFinder: (path: string) => void; fileManagerName: string; onSetTrafficLightsVisible: (visible: boolean) => void; }
  shikiTheme: string
  windowWorkspaceId: string | null
  windowWorkspaceSlug: string | null
  handleSwitchWorkspaceBySlug: (slug: string) => void
  handleCreateSession: (workspaceId: string, options?: import("../shared/types").CreateSessionOptions) => Promise<Session>
  handleInputChange: (sessionId: string, value: string) => void
  getDraft: (sessionId: string) => string
  handleAutoDeleteEmptySession: (sessionId: string) => void
  sessionsLoaded: boolean
  windowRemoteWorkspaceId: string | null
  splashExiting: boolean
  handleSplashExitComplete: () => void
  showTransportConnectionBanner: boolean
  connectionState: import("../shared/types").TransportConnectionState | null
  handleReconnectTransport: () => void
  sessionLoadError: string | null
  loadSessionsFromServer: () => Promise<void>
  appShellContextValue: AppShellContextType
  menuNewChatTrigger: number
  isFocusedMode: boolean
  linkInterceptor: ReturnType<typeof useLinkInterceptor>
  isDark: boolean
}

export function AppMainView({
  appState,
  handleReauthLogin,
  handleReauthReset,
  showResetDialog,
  executeReset,
  setShowResetDialog,
  onboarding,
  setWindowWorkspaceId,
  setAppState,
  splashHidden,
  platformActions,
  shikiTheme,
  windowWorkspaceId,
  windowWorkspaceSlug,
  handleSwitchWorkspaceBySlug,
  handleCreateSession,
  handleInputChange,
  getDraft,
  handleAutoDeleteEmptySession,
  sessionsLoaded,
  windowRemoteWorkspaceId,
  splashExiting,
  handleSplashExitComplete,
  showTransportConnectionBanner,
  connectionState,
  handleReconnectTransport,
  sessionLoadError,
  loadSessionsFromServer,
  appShellContextValue,
  menuNewChatTrigger,
  isFocusedMode,
  linkInterceptor,
  isDark,
}: AppMainViewProps) {

  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

if (appState === 'reauth') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <ReauthScreen
            onLogin={handleReauthLogin}
            onReset={document.documentElement.dataset["robbRuntime"] === 'web' ? undefined : handleReauthReset}
          />
          <ResetConfirmationDialog
            open={showResetDialog}
            onConfirm={executeReset}
            onCancel={() => setShowResetDialog(false)}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

if (appState === 'onboarding') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <OnboardingWizard
            state={onboarding.state}
            onContinue={onboarding.handleContinue}
            onBack={onboarding.handleBack}
            onSelectProvider={onboarding.handleSelectProvider}
            onSkipSetup={onboarding.handleSkipSetup}
            onSelectApiSetupMethod={onboarding.handleSelectApiSetupMethod}
            onSubmitCredential={onboarding.handleSubmitCredential}
            onSubmitLocalModel={onboarding.handleSubmitLocalModel}
            onStartOAuth={onboarding.handleStartOAuth}
            onFinish={onboarding.handleFinish}
            isWaitingForCode={onboarding.isWaitingForCode}
            onSubmitAuthCode={onboarding.handleSubmitAuthCode}
            onCancelOAuth={onboarding.handleCancelOAuth}
            copilotDeviceCode={onboarding.copilotDeviceCode}
            onBrowseGitBash={onboarding.handleBrowseGitBash}
            onUseGitBashPath={onboarding.handleUseGitBashPath}
            onRecheckGitBash={onboarding.handleRecheckGitBash}
            onClearError={onboarding.handleClearError}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

const showSplash = !splashHidden

return (
    <PlatformProvider actions={platformActions}>
    <ShikiThemeProvider shikiTheme={shikiTheme}>
      <ActionRegistryProvider>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          workspaceSlug={windowWorkspaceSlug}
          onSwitchWorkspaceBySlug={handleSwitchWorkspaceBySlug}
          onCreateSession={handleCreateSession}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
        >
          {/* Handle window close requests (X button, Cmd+W) - close modal first if open */}
          <WindowCloseHandler />

          {/* Splash screen overlay - fades out when fully ready */}
          {showSplash && (
            <SplashScreen
              isExiting={splashExiting}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* Main UI - always rendered, splash fades away to reveal it */}
          <div
            className="h-full flex flex-col text-foreground"
            style={{ paddingTop: 'var(--topbar-height)' }}
          >
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex-1 min-h-0">
              {sessionLoadError ? (
                <SessionLoadErrorScreen
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              ) : (
                <AppShell
                  contextValue={appShellContextValue}
                  defaultLayout={[20, 32, 48]}
                  menuNewChatTrigger={menuNewChatTrigger}
                  isFocusedMode={isFocusedMode}
                />
              )}
            </div>
            <ResetConfirmationDialog
              open={showResetDialog}
              onConfirm={executeReset}
              onCancel={() => setShowResetDialog(false)}
            />
          </div>

          {/* File preview overlay — rendered by the link interceptor when a previewable file is clicked */}
          {linkInterceptor.previewState && (
            <FilePreviewRenderer
              state={linkInterceptor.previewState}
              onClose={linkInterceptor.closePreview}
              loadDataUrl={linkInterceptor.readFileDataUrl}
              loadPdfData={linkInterceptor.readFileBinary}
              onOpenFile={platformActions.onOpenFile}
              onOpenUrl={platformActions.onOpenUrl}
              isDark={isDark}
            />
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
      </ActionRegistryProvider>
    </ShikiThemeProvider>
    </PlatformProvider>
  )
}
