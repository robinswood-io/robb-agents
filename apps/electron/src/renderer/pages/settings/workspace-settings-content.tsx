import * as React from 'react';

import { motion, AnimatePresence } from 'motion/react';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HeaderMenu } from '@/components/ui/HeaderMenu';

import { cn } from '@/lib/utils';
import { routes } from '@/lib/navigate';
import { Spinner } from '@craft-agent/ui';
import { RenameDialog } from '@/components/ui/rename-dialog';
import type { PermissionMode, WorkspaceSettings, LoadedSource } from '../../../shared/types';
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker';
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser';

import { SourceAvatar } from '@/components/ui/source-avatar';

import { SettingsSection, SettingsCard, SettingsRow, SettingsToggle, SettingsMenuSelectRow } from '@/components/settings';
import type { TFunction } from "i18next";

interface WorkspaceSettingsContentProps {
  t: TFunction<"translation", undefined>
  wsName: string
  setWsNameEditing: React.Dispatch<React.SetStateAction<string>>
  setRenameDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  handleIconUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  isUploadingIcon: boolean
  wsIconUrl: string | null
  renameDialogOpen: boolean
  wsNameEditing: string
  setWsName: React.Dispatch<React.SetStateAction<string>>
  updateWorkspaceSetting: <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => Promise<boolean>
  onRefreshWorkspaces: (() => void) | undefined
  permissionMode: PermissionMode
  handlePermissionModeChange: (mode: PermissionMode) => Promise<void>
  externalActionPolicy: "confirm" | "allow-in-execute"
  handleTotalAutonomyChange: (enabled: boolean) => Promise<void>
  enabledModes: PermissionMode[]
  handleModeToggle: (mode: PermissionMode, checked: boolean) => Promise<void>
  modeCyclingError: string | null
  availableSources: LoadedSource[]
  enabledSourceSlugs: string[]
  handleSourceToggle: (slug: string, checked: boolean) => Promise<void>
  handleSaveCostControl: () => Promise<void>
  isSavingCostControl: boolean
  costControlText: string
  setCostControlText: React.Dispatch<React.SetStateAction<string>>
  setCostControlError: React.Dispatch<React.SetStateAction<string | null>>
  costControlError: string | null
  workingDirectory: string
  handleClearWorkingDirectory: () => Promise<void>
  handleChangeWorkingDirectory: () => void
  localMcpEnabled: boolean
  handleLocalMcpEnabledChange: (enabled: boolean) => Promise<void>
  showWdBrowser: boolean
  wdBrowserMode: ReturnType<typeof useDirectoryPicker>["serverBrowserMode"]
  confirmWdBrowser: (path: string) => void
  cancelWdBrowser: () => void
}

export function WorkspaceSettingsContent({
  t,
  wsName,
  setWsNameEditing,
  setRenameDialogOpen,
  handleIconUpload,
  isUploadingIcon,
  wsIconUrl,
  renameDialogOpen,
  wsNameEditing,
  setWsName,
  updateWorkspaceSetting,
  onRefreshWorkspaces,
  permissionMode,
  handlePermissionModeChange,
  externalActionPolicy,
  handleTotalAutonomyChange,
  enabledModes,
  handleModeToggle,
  modeCyclingError,
  availableSources,
  enabledSourceSlugs,
  handleSourceToggle,
  handleSaveCostControl,
  isSavingCostControl,
  costControlText,
  setCostControlText,
  setCostControlError,
  costControlError,
  workingDirectory,
  handleClearWorkingDirectory,
  handleChangeWorkingDirectory,
  localMcpEnabled,
  handleLocalMcpEnabledChange,
  showWdBrowser,
  wdBrowserMode,
  confirmWdBrowser,
  cancelWdBrowser,
}: WorkspaceSettingsContentProps) {
  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.workspace.workspaceSettings")} actions={<HeaderMenu route={routes.view.settings('workspace')} helpFeature="workspaces" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
          <div className="space-y-8">
            {/* Workspace Info */}
            <SettingsSection title={t("settings.workspace.workspaceInfo")}>
              <SettingsCard>
                <SettingsRow
                  label={t("common.name")}
                  description={wsName || t("settings.workspace.untitled")}
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        setWsNameEditing(wsName)
                        setRenameDialogOpen(true)
                      }}
                      className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
                    >
                      {t("common.edit")}
                    </button>
                  }
                />
                <SettingsRow
                  label={t("settings.workspace.icon")}
                  action={
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                        onChange={handleIconUpload}
                        className="sr-only"
                        disabled={isUploadingIcon}
                      />
                      <span className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors">
                        {isUploadingIcon ? t("common.uploading") : t("common.change")}
                      </span>
                    </label>
                  }
                >
                  <div
                    className={cn(
                      'w-6 h-6 rounded-full overflow-hidden bg-foreground/5 flex items-center justify-center',
                      'ring-1 ring-border/50'
                    )}
                  >
                    {isUploadingIcon ? (
                      <Spinner className="text-muted-foreground text-[8px]" />
                    ) : wsIconUrl ? (
                      <img src={wsIconUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {wsName?.charAt(0)?.toUpperCase() || 'W'}
                      </span>
                    )}
                  </div>
                </SettingsRow>
              </SettingsCard>

              <RenameDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                title={t("settings.workspace.renameWorkspace")}
                value={wsNameEditing}
                onValueChange={setWsNameEditing}
                onSubmit={() => {
                  const newName = wsNameEditing.trim()
                  if (newName && newName !== wsName) {
                    setWsName(newName)
                    updateWorkspaceSetting('name', newName)
                    onRefreshWorkspaces?.()
                  }
                  setRenameDialogOpen(false)
                }}
                placeholder={t("settings.workspace.enterWorkspaceName")}
              />
            </SettingsSection>

            {/* Permissions */}
            <SettingsSection title={t("settings.workspace.permissionsSection")}>
              <SettingsCard>
                <SettingsMenuSelectRow
                  label={t("settings.workspace.defaultMode")}
                  description={t("settings.workspace.defaultModeDesc")}
                  value={permissionMode}
                  onValueChange={(v) => handlePermissionModeChange(v as PermissionMode)}
                  options={[
                    { value: 'safe', label: t("mode.explore"), description: t("mode.exploreDesc") },
                    { value: 'ask', label: t("mode.ask"), description: t("mode.askDesc") },
                    { value: 'allow-all', label: t("mode.execute"), description: t("mode.executeDesc") },
                  ]}
                />
                <SettingsToggle
                  label={t("settings.workspace.totalAutonomy")}
                  description={t("settings.workspace.totalAutonomyDesc")}
                  checked={externalActionPolicy === 'allow-in-execute'}
                  onCheckedChange={handleTotalAutonomyChange}
                />
              </SettingsCard>
            </SettingsSection>

            {/* Mode Cycling */}
            <SettingsSection
              title={t("settings.workspace.modeCycling")}
              description={t("settings.workspace.modeCyclingDesc")}
            >
              <SettingsCard>
                {(['safe', 'ask', 'allow-all'] as const).map((m) => {
                  const modeTranslations = {
                    'safe': { label: t("mode.explore"), desc: t("mode.exploreFullDesc") },
                    'ask': { label: t("mode.askToEdit"), desc: t("mode.askFullDesc") },
                    'allow-all': { label: t("mode.execute"), desc: t("mode.executeFullDesc") },
                  }
                  const isEnabled = enabledModes.includes(m)
                  return (
                    <SettingsToggle
                      key={m}
                      label={modeTranslations[m].label}
                      description={modeTranslations[m].desc}
                      checked={isEnabled}
                      onCheckedChange={(checked) => handleModeToggle(m, checked)}
                    />
                  )
                })}
              </SettingsCard>
              <AnimatePresence>
                {modeCyclingError && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    className="text-xs text-destructive mt-1 overflow-hidden"
                  >
                    {modeCyclingError}
                  </motion.p>
                )}
              </AnimatePresence>
            </SettingsSection>

            {/* Default Sources */}
            <SettingsSection
              title={t("settings.workspace.defaultSources")}
              description={t("settings.workspace.defaultSourcesDesc")}
            >
              {availableSources.length > 0 ? (
                <SettingsCard>
                  {availableSources.map((source) => (
                    <SettingsToggle
                      key={source.config.slug}
                      label={
                        <span className="inline-flex items-center gap-2">
                          <SourceAvatar source={source} size="xs" />
                          {source.config.name}
                        </span>
                      }
                      description={source.config.tagline}
                      checked={enabledSourceSlugs.includes(source.config.slug)}
                      onCheckedChange={(checked) => handleSourceToggle(source.config.slug, checked)}
                    />
                  ))}
                </SettingsCard>
              ) : (
                <p className="text-sm text-muted-foreground">{t("settings.workspace.noSourcesConfigured")}</p>
              )}
            </SettingsSection>

            {/* Agent cost controls */}
            <SettingsSection
              title={t('settings.workspace.costControlTitle')}
              description={t('settings.workspace.costControlDesc')}
            >
              <SettingsCard>
                <div className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{t('settings.workspace.costControlJson')}</div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('settings.workspace.costControlDefaults')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSaveCostControl}
                      disabled={isSavingCostControl}
                      className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors disabled:opacity-50"
                    >
                      {isSavingCostControl ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                  <textarea
                    value={costControlText}
                    onChange={(event) => {
                      setCostControlText(event.target.value)
                      setCostControlError(null)
                    }}
                    spellCheck={false}
                    className="min-h-[320px] w-full resize-y rounded-lg bg-foreground-2 px-3 py-2 font-mono text-xs text-foreground outline-none shadow-minimal focus:bg-background focus:ring-2 focus:ring-ring"
                  />
                  {costControlError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                      {costControlError}
                    </div>
                  )}
                </div>
              </SettingsCard>
            </SettingsSection>


            {/* Advanced */}
            <SettingsSection title={t("settings.workspace.advanced")}>
              <SettingsCard>
                <SettingsRow
                  label={t("settings.workspace.defaultWorkingDir")}
                  description={workingDirectory || t("settings.workspace.defaultWorkingDirDesc")}
                  action={
                    <div className="flex items-center gap-2">
                      {workingDirectory && (
                        <button
                          type="button"
                          onClick={handleClearWorkingDirectory}
                          className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors text-foreground/60 hover:text-foreground"
                        >
                          {t("common.clear")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleChangeWorkingDirectory}
                        className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
                      >
                        {t("common.change")}
                      </button>
                    </div>
                  }
                />
                <SettingsToggle
                  label={t("settings.workspace.localMcpServers")}
                  description={t("settings.workspace.localMcpServersDesc")}
                  checked={localMcpEnabled}
                  onCheckedChange={handleLocalMcpEnabledChange}
                />
              </SettingsCard>
            </SettingsSection>

          </div>
        </div>
        </ScrollArea>
      </div>
      <ServerDirectoryBrowser
        open={showWdBrowser}
        mode={wdBrowserMode}
        onSelect={confirmWdBrowser}
        onCancel={cancelWdBrowser}
        initialPath={workingDirectory || undefined}
      />
    </div>
  )
}
