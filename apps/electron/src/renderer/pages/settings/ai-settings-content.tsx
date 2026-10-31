

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { routes } from '@/lib/navigate';
import { X, RefreshCcw } from 'lucide-react';
import type { CredentialHealthIssue } from '../../../shared/types';
import { FullscreenOverlayBase } from '@craft-agent/ui';

import type { LlmConnectionWithStatus, ThinkingLevel, Workspace } from '../../../shared/types';
import { THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels';
import { ROBINSWOOD_BACKEND_NAME } from '@craft-agent/shared/robinswood-branding';

import { SettingsSection, SettingsCard, SettingsRow, SettingsMenuSelectRow, SettingsToggle } from '@/components/settings';
import { useOnboarding } from '@/hooks/useOnboarding';

import { OnboardingWizard } from '@/components/onboarding';
import { RenameDialog } from '@/components/ui/rename-dialog';

import { type CustomEndpointApi, type MidStreamBehavior } from '@config/llm-connections';

import { formatTokenCount, getModelOptionsForConnection, CredentialHealthBanner, type ValidationState, ConnectionRow } from "./ai-connection-settings";
import { WorkspaceOverrideCard } from "./ai-workspace-overrides";

interface AiSettingsContentProps {
  t: import("i18next").TFunction<"translation", undefined>
  credentialHealthIssues: CredentialHealthIssue[]
  handleReauthenticate: () => void
  llmConnections: LlmConnectionWithStatus[]
  defaultConnection: LlmConnectionWithStatus | undefined
  handleSetDefaultConnection: (slug: string) => Promise<void>
  defaultModel: string
  handleDefaultModelChange: (model: string) => Promise<void>
  defaultThinking: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  handleDefaultThinkingChange: (level: ThinkingLevel) => Promise<void>
  workspaces: Workspace[]
  handleWorkspaceSettingsChange: () => void
  handleRenameClick: (connection: LlmConnectionWithStatus) => void
  handleDeleteConnection: (slug: string) => Promise<void>
  handleValidateConnection: (slug: string) => Promise<void>
  handleReauthenticateConnection: (connection: LlmConnectionWithStatus) => void
  handleEditConnection: (connection: LlmConnectionWithStatus) => Promise<void>
  handleSetMidStreamBehavior: (connection: LlmConnectionWithStatus, behavior: MidStreamBehavior) => Promise<void>
  validationStates: Record<string, { state: ValidationState; error?: string; }>
  duplicateAccountUuids: Set<string>
  openApiSetup: (connectionSlug?: string) => void
  enable1MContext: boolean
  handleEnable1MContextChange: (enabled: boolean) => Promise<void>
  extendedPromptCache: boolean
  handleExtendedPromptCacheChange: (enabled: boolean) => Promise<void>
  rtkStatus: { installed: boolean; path: string | null; version: string | null; } | null
  rtkEnabled: boolean
  handleRtkToggle: (enabled: boolean) => Promise<void>
  rtkGain: { totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number; } | null
  refreshRtkGain: () => Promise<void>
  handleGetRtk: () => void
  handleRecheckRtk: () => Promise<void>
  rtkRechecking: boolean
  showApiSetup: boolean
  handleCloseApiSetup: () => void
  apiSetupOnboarding: ReturnType<typeof useOnboarding>
  isDirectEdit: boolean
  handleApiSetupFinish: () => void
  editInitialValues: { apiKey?: string; baseUrl?: string; connectionDefaultModel?: string; activePreset?: string; models?: string[]; customApi?: CustomEndpointApi; googleCloudProject?: string; } | undefined
  renameDialogOpen: boolean
  setRenameDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>
  renameValue: string
  setRenameValue: import("react").Dispatch<import("react").SetStateAction<string>>
  handleRenameSubmit: () => Promise<void>
}

export function AiSettingsContent({
  t,
  credentialHealthIssues,
  handleReauthenticate,
  llmConnections,
  defaultConnection,
  handleSetDefaultConnection,
  defaultModel,
  handleDefaultModelChange,
  defaultThinking,
  handleDefaultThinkingChange,
  workspaces,
  handleWorkspaceSettingsChange,
  handleRenameClick,
  handleDeleteConnection,
  handleValidateConnection,
  handleReauthenticateConnection,
  handleEditConnection,
  handleSetMidStreamBehavior,
  validationStates,
  duplicateAccountUuids,
  openApiSetup,
  enable1MContext,
  handleEnable1MContextChange,
  extendedPromptCache,
  handleExtendedPromptCacheChange,
  rtkStatus,
  rtkEnabled,
  handleRtkToggle,
  rtkGain,
  refreshRtkGain,
  handleGetRtk,
  handleRecheckRtk,
  rtkRechecking,
  showApiSetup,
  handleCloseApiSetup,
  apiSetupOnboarding,
  isDirectEdit,
  handleApiSetupFinish,
  editInitialValues,
  renameDialogOpen,
  setRenameDialogOpen,
  renameValue,
  setRenameValue,
  handleRenameSubmit,
}: AiSettingsContentProps) {
  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.ai.title")} actions={<HeaderMenu route={routes.view.settings('ai')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            {/* Credential Health Warning Banner */}
            <CredentialHealthBanner
              issues={credentialHealthIssues}
              onReauthenticate={handleReauthenticate}
            />

            <div className="space-y-8">
              {/* Default Settings - only show if connections exist */}
              {llmConnections.length > 0 && (
              <SettingsSection title={t("settings.ai.defaultSection")} description={t("settings.ai.defaultSectionDesc")}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t("settings.ai.connection")}
                    description={t("settings.ai.connectionDesc")}
                    value={defaultConnection?.slug || ''}
                    onValueChange={handleSetDefaultConnection}
                    options={llmConnections.map((conn) => ({
                      value: conn.slug,
                      label: conn.name,
                      description: conn.providerType === 'anthropic' ? 'Anthropic API' :
                                   conn.providerType === 'pi' ? ROBINSWOOD_BACKEND_NAME :
                                   conn.providerType === 'pi_compat' ? (conn.baseUrl?.toLowerCase().includes('manifest.build') ? 'Manifest' : `${ROBINSWOOD_BACKEND_NAME} Compatible`) :
                                   conn.providerType || 'Unknown',
                    }))}
                  />
                  <SettingsMenuSelectRow
                    label={t("settings.ai.model")}
                    description={t("settings.ai.modelDesc")}
                    value={defaultModel}
                    onValueChange={handleDefaultModelChange}
                    options={getModelOptionsForConnection(defaultConnection).map(o => ({
                      ...o, description: o.descriptionKey ? t(o.descriptionKey) : o.description,
                    }))}
                  />
                  <SettingsMenuSelectRow
                    label={t("settings.ai.thinking")}
                    description={t("settings.ai.thinkingDesc")}
                    value={defaultThinking}
                    onValueChange={(v) => handleDefaultThinkingChange(v as ThinkingLevel)}
                    options={THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                      value: id,
                      label: t(nameKey),
                      description: t(descriptionKey),
                    }))}
                  />
                </SettingsCard>
              </SettingsSection>
              )}

              {/* Workspace Overrides - only show if connections exist */}
              {workspaces.length > 0 && llmConnections.length > 0 && (
                <SettingsSection title={t("settings.ai.workspaceOverrides")} description={t("settings.ai.workspaceOverridesDesc")}>
                  <div className="space-y-2">
                    {workspaces.map((workspace) => (
                      <WorkspaceOverrideCard
                        key={workspace.id}
                        workspace={workspace}
                        llmConnections={llmConnections}
                        onSettingsChange={handleWorkspaceSettingsChange}
                      />
                    ))}
                  </div>
                </SettingsSection>
              )}

              {/* Connections Management */}
              <SettingsSection title={t("settings.ai.connections")} description={t("settings.ai.connectionsDesc")}>
                <SettingsCard>
                  {llmConnections.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t("settings.ai.noConnections")}
                    </div>
                  ) : (
                    [...llmConnections]
                      .sort((a, b) => {
                        if (a.isDefault && !b.isDefault) return -1
                        if (!a.isDefault && b.isDefault) return 1
                        return a.name.localeCompare(b.name)
                      })
                      .map((conn) => (
                      <ConnectionRow
                        key={conn.slug}
                        connection={conn}
                        isLastConnection={false}
                        onRenameClick={() => handleRenameClick(conn)}
                        onDelete={() => handleDeleteConnection(conn.slug)}
                        onSetDefault={() => handleSetDefaultConnection(conn.slug)}
                        onValidate={() => handleValidateConnection(conn.slug)}
                        onReauthenticate={() => handleReauthenticateConnection(conn)}
                        onEdit={() => handleEditConnection(conn)}
                        onSetMidStreamBehavior={(behavior) => handleSetMidStreamBehavior(conn, behavior)}
                        validationState={validationStates[conn.slug]?.state || 'idle'}
                        validationError={validationStates[conn.slug]?.error}
                        isDuplicateAccount={!!conn.oauthAccountUuid && duplicateAccountUuids.has(conn.oauthAccountUuid)}
                      />
                    ))
                  )}
                </SettingsCard>
                <div className="pt-0">
                  <button
                    onClick={() => openApiSetup()}
                    className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
                  >
                    {t("settings.ai.addConnection")}
                  </button>
                </div>
              </SettingsSection>

              {/* Performance */}
              <SettingsSection title={t("settings.ai.performance")} description={t("settings.ai.performanceDesc")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.ai.extendedContext")}
                    description={t("settings.ai.extendedContextDesc")}
                    checked={enable1MContext}
                    onCheckedChange={handleEnable1MContextChange}
                  />
                  <SettingsToggle
                    label={t("settings.ai.extendedPromptCache")}
                    description={t("settings.ai.extendedPromptCacheDesc")}
                    checked={extendedPromptCache}
                    onCheckedChange={handleExtendedPromptCacheChange}
                  />
                  {rtkStatus?.installed ? (
                    <>
                      <SettingsToggle
                        label={t("settings.ai.rtk.title")}
                        description={t("settings.ai.rtk.description")}
                        checked={rtkEnabled}
                        onCheckedChange={handleRtkToggle}
                      />
                      {rtkEnabled && rtkGain && rtkGain.totalCommands > 0 && (
                        <div className="px-4 pb-4 -mt-1">
                          <div className="flex items-center justify-between text-xs text-foreground/60">
                            <span>
                              {t("settings.ai.rtk.gainSummary", {
                                saved: formatTokenCount(rtkGain.totalSaved),
                                count: rtkGain.totalCommands,
                                pct: rtkGain.avgSavingsPct.toFixed(1),
                              })}
                            </span>
                            <button
                              type="button"
                              onClick={refreshRtkGain}
                              className="text-foreground/60 hover:text-foreground transition-colors"
                              aria-label={t("settings.ai.rtk.gainRefresh")}
                            >
                              <RefreshCcw className="size-3" />
                            </button>
                          </div>
                          <div className="mt-2 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                            <div
                              className="h-full bg-foreground/60 transition-all"
                              style={{ width: `${Math.min(100, Math.max(0, rtkGain.avgSavingsPct))}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <SettingsRow
                      label={t("settings.ai.rtk.title")}
                      description={rtkStatus === null ? t("common.checking") : t("settings.ai.rtk.notInstalledDesc")}
                    >
                      <Button
                        size="sm"
                        onClick={handleGetRtk}
                        className="bg-background shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg"
                      >
                        {t("settings.ai.rtk.getRtk")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleRecheckRtk}
                        disabled={rtkRechecking || rtkStatus === null}
                        className="bg-background shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg"
                      >
                        {rtkRechecking ? t("common.checking") : t("settings.ai.rtk.recheck")}
                      </Button>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* API Setup Fullscreen Overlay */}
              <FullscreenOverlayBase
                isOpen={showApiSetup}
                onClose={handleCloseApiSetup}
                className="z-splash flex flex-col bg-foreground-2"
              >
                <OnboardingWizard
                  state={apiSetupOnboarding.state}
                  onContinue={apiSetupOnboarding.handleContinue}
                  onBack={isDirectEdit ? handleCloseApiSetup : apiSetupOnboarding.handleBack}
                  onSelectProvider={apiSetupOnboarding.handleSelectProvider}
                  onSelectApiSetupMethod={apiSetupOnboarding.handleSelectApiSetupMethod}
                  onSubmitCredential={apiSetupOnboarding.handleSubmitCredential}
                  onSubmitLocalModel={apiSetupOnboarding.handleSubmitLocalModel}
                  onStartOAuth={apiSetupOnboarding.handleStartOAuth}
                  onFinish={handleApiSetupFinish}
                  isWaitingForCode={apiSetupOnboarding.isWaitingForCode}
                  onSubmitAuthCode={apiSetupOnboarding.handleSubmitAuthCode}
                  onCancelOAuth={apiSetupOnboarding.handleCancelOAuth}
                  copilotDeviceCode={apiSetupOnboarding.copilotDeviceCode}
                  editInitialValues={editInitialValues}
                  className="h-full"
                />
                <div
                  className="fixed top-0 right-0 h-[50px] flex items-center pr-5 [-webkit-app-region:no-drag]"
                  style={{ zIndex: 'var(--z-fullscreen, 350)' }}
                >
                  <button
                    onClick={handleCloseApiSetup}
                    className="p-1.5 rounded-[6px] transition-all bg-background shadow-minimal text-muted-foreground/50 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title={t("common.closeEsc")}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </FullscreenOverlayBase>

              {/* Rename Connection Dialog */}
              <RenameDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                title={t("settings.ai.renameConnection")}
                value={renameValue}
                onValueChange={setRenameValue}
                onSubmit={handleRenameSubmit}
                placeholder={t("settings.ai.enterConnectionName")}
              />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
