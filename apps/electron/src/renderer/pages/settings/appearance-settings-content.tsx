

import { LANGUAGES, type LanguageCode } from '@craft-agent/shared/i18n';
import type { ColumnDef } from '@/components/ui/data-table';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { cn } from '@/lib/utils';
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover';

import { routes } from '@/lib/navigate';
import { Monitor, Sun, Moon } from 'lucide-react';

import type { ToolIconMapping } from '../../../shared/types';
import { SettingsSection, SettingsCard, SettingsRow, SettingsSegmentedControl, SettingsMenuSelect, SettingsToggle } from '@/components/settings';

import { WorkspaceAvatar } from '@/components/ui/workspace-avatar';
import { ColorPicker } from '@/components/ui/color-picker';

import { KANBAN_COLUMNS } from '@/components/app-shell/kanban/status-column';
import { DEFAULT_KANBAN_COLUMN_COLORS } from '@/components/app-shell/kanban/kanban-colors';
import type { KanbanColumnId } from '@/components/app-shell/kanban/types';

import { PROJECT_COLOR_PALETTE, type ProjectColorTreatment } from '@/utils/project-colors';
import { Info_DataTable } from '@/components/info/Info_DataTable';

import type { PresetTheme, ThemeOverrides } from '@config/theme';

const PALETTE_FIELDS = [
  'background',
  'paper',
  'navigator',
  'foreground',
  'accent',
  'info',
  'success',
  'destructive',
] as const

export type PaletteField = typeof PALETTE_FIELDS[number]

interface AppearanceSettingsContentProps {
  t: import("i18next").TFunction<"translation", undefined>
  mode: import("@/context/ThemeContext").ThemeMode
  setMode: (mode: import("@/context/ThemeContext").ThemeMode) => void
  colorTheme: string
  setColorTheme: (theme: string) => void
  themeOptions: { value: string; label: string; }[]
  font: import("@/context/ThemeContext").FontFamily
  setFont: (font: import("@/context/ThemeContext").FontFamily) => void
  i18n: import("i18next").i18n
  themeLoadError: string | null
  themeResolvedFrom: "none" | "ipc" | "fallback"
  presetThemes: PresetTheme[]
  setPreviewColorTheme: (theme: string | null) => void
  paletteMode: "light" | "dark"
  setPaletteMode: import("react").Dispatch<import("react").SetStateAction<"light" | "dark">>
  customTheme: ThemeOverrides | null
  resolvedTheme: ThemeOverrides
  updatePaletteColor: (field: PaletteField, color: string) => void
  clearPaletteColor: (field: PaletteField) => void
  resetCustomPalette: () => void
  workspaces: import("@craft-agent/core").Workspace[]
  workspaceThemes: Record<string, string | undefined>
  workspaceAvatarColors: import("@/atoms/workspace-avatar-colors").WorkspaceAvatarColors
  setWorkspaceAvatarColor: (workspaceId: string, hex: string) => void
  clearWorkspaceAvatarColor: (workspaceId: string) => void
  workspaceIconMap: Map<string, string>
  handleWorkspaceThemeChange: (workspaceId: string, value: string) => Promise<void>
  appDefaultLabel: string | null
  showConnectionIcons: boolean
  handleConnectionIconsChange: (checked: boolean) => void
  richToolDescriptions: boolean
  handleRichToolDescriptionsChange: (checked: boolean) => Promise<void>
  showBackgroundFinishedChip: boolean
  setShowBackgroundFinishedChip: (args_0: boolean | typeof import("jotai/utils").RESET | ((prev: boolean) => boolean | typeof import("jotai/utils").RESET)) => void
  projectColorTreatment: ProjectColorTreatment
  handleProjectColorTreatmentChange: (value: string) => void
  kanbanColumnColors: Partial<Record<string, string>>
  setKanbanColumnColor: (column: KanbanColumnId, hex: string) => void
  resetKanbanColumnColor: (column: KanbanColumnId) => void
  kanbanLivePulse: boolean
  setKanbanLivePulse: (args_0: boolean | typeof import("jotai/utils").RESET | ((prev: boolean) => boolean | typeof import("jotai/utils").RESET)) => void
  kanbanColumnStatus: Partial<Record<string, string>>
  setColumnStatus: (column: KanbanColumnId, statusId: string) => void
  columnStatusOptions: { value: string; label: string; }[]
  toolIconsJsonPath: string | null
  toolIconColumns: ColumnDef<ToolIconMapping>[]
  toolIcons: ToolIconMapping[]
}

export function AppearanceSettingsContent({
  t,
  mode,
  setMode,
  colorTheme,
  setColorTheme,
  themeOptions,
  font,
  setFont,
  i18n,
  themeLoadError,
  themeResolvedFrom,
  presetThemes,
  setPreviewColorTheme,
  paletteMode,
  setPaletteMode,
  customTheme,
  resolvedTheme,
  updatePaletteColor,
  clearPaletteColor,
  resetCustomPalette,
  workspaces,
  workspaceThemes,
  workspaceAvatarColors,
  setWorkspaceAvatarColor,
  clearWorkspaceAvatarColor,
  workspaceIconMap,
  handleWorkspaceThemeChange,
  appDefaultLabel,
  showConnectionIcons,
  handleConnectionIconsChange,
  richToolDescriptions,
  handleRichToolDescriptionsChange,
  showBackgroundFinishedChip,
  setShowBackgroundFinishedChip,
  projectColorTreatment,
  handleProjectColorTreatmentChange,
  kanbanColumnColors,
  setKanbanColumnColor,
  resetKanbanColumnColor,
  kanbanLivePulse,
  setKanbanLivePulse,
  kanbanColumnStatus,
  setColumnStatus,
  columnStatusOptions,
  toolIconsJsonPath,
  toolIconColumns,
  toolIcons,
}: AppearanceSettingsContentProps) {
  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t("settings.appearance.title")}
        actions={<HeaderMenu route={routes.view.settings('appearance')} helpFeature="themes" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">

              {/* Default Theme */}
              <SettingsSection title={t("settings.appearance.defaultTheme")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.appearance.mode")}>
                    <SettingsSegmentedControl
                      value={mode}
                      onValueChange={setMode}
                      options={[
                        { value: 'system', label: t("settings.appearance.system"), icon: <Monitor className="w-4 h-4" /> },
                        { value: 'light', label: t("settings.appearance.light"), icon: <Sun className="w-4 h-4" /> },
                        { value: 'dark', label: t("settings.appearance.dark"), icon: <Moon className="w-4 h-4" /> },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.colorTheme")}>
                    <SettingsMenuSelect
                      value={colorTheme}
                      onValueChange={setColorTheme}
                      options={themeOptions}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.font")}>
                    <SettingsSegmentedControl
                      value={font}
                      onValueChange={setFont}
                      options={[
                        { value: 'inter', label: t("settings.appearance.fontInter") },
                        { value: 'system', label: t("settings.appearance.fontSystem") },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.language")}>
                    <SettingsMenuSelect
                      value={(i18n.resolvedLanguage ?? i18n.language) as LanguageCode}
                      onValueChange={(value) => {
                        console.info('[i18n] Appearance dropdown change', {
                          from: i18n.resolvedLanguage ?? null,
                          to: value,
                        })
                        i18n.changeLanguage(value)
                        window.electronAPI?.changeLanguage?.(value)
                      }}
                      options={Object.entries(LANGUAGES).map(([code, config]) => ({
                        value: code,
                        label: config.nativeName,
                      }))}
                    />
                  </SettingsRow>
                </SettingsCard>
                {themeLoadError && (
                  <p className="mt-2 text-xs text-info">
                    {t("settings.appearance.themeWarning")} {themeLoadError} ({themeResolvedFrom === 'fallback' ? t("settings.appearance.usingBundledFallback") : t("settings.appearance.usingDefaultTheme")})
                  </p>
                )}
              </SettingsSection>

              <SettingsSection title={t('settings.appearance.themeGallery')} description={t('settings.appearance.themeGalleryDesc')}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {presetThemes
                    .filter(({ id }) => ['default', 'robinswood', 'nord', 'tokyo-night', 'catppuccin', 'gruvbox', 'pierre'].includes(id))
                    .map(({ id, theme }) => {
                      const preview = theme.dark?.background ?? theme.background ?? '#1E1D21'
                      const accent = theme.dark?.accent ?? theme.accent ?? '#A78BFA'
                      const selected = colorTheme === id
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setColorTheme(id)}
                          onMouseEnter={() => setPreviewColorTheme(id)}
                          onMouseLeave={() => setPreviewColorTheme(null)}
                          onFocus={() => setPreviewColorTheme(id)}
                          onBlur={() => setPreviewColorTheme(null)}
                          className={cn(
                            'rounded-md border p-3 text-left transition-colors',
                            selected ? 'border-accent ring-1 ring-accent' : 'border-foreground/10 hover:border-foreground/30',
                          )}
                          aria-pressed={selected}
                        >
                          <div className="mb-2 flex h-8 overflow-hidden rounded-sm" style={{ backgroundColor: preview }}>
                            <span className="w-2/3" />
                            <span className="w-1/3" style={{ backgroundColor: accent }} />
                          </div>
                          <span className="text-xs font-medium">{theme.name || id}</span>
                        </button>
                      )
                    })}
                </div>
              </SettingsSection>

              {/* Global custom palette — persisted as ~/.craft-agent/theme.json */}
              <SettingsSection
                title={t('settings.appearance.customPalette')}
                description={t('settings.appearance.customPaletteDesc')}
              >
                <SettingsCard>
                  <SettingsRow label={t('settings.appearance.paletteMode')}>
                    <SettingsSegmentedControl
                      value={paletteMode}
                      onValueChange={(value) => setPaletteMode(value as 'light' | 'dark')}
                      options={[
                        { value: 'light', label: t('settings.appearance.light'), icon: <Sun className="w-4 h-4" /> },
                        { value: 'dark', label: t('settings.appearance.dark'), icon: <Moon className="w-4 h-4" /> },
                      ]}
                    />
                  </SettingsRow>
                  {PALETTE_FIELDS.map((key) => {
                    const label = t(`settings.appearance.palette${key.charAt(0).toUpperCase()}${key.slice(1)}`)
                    const override = paletteMode === 'dark' ? customTheme?.dark?.[key] : customTheme?.[key]
                    const fallback = paletteMode === 'dark' ? resolvedTheme.dark?.[key] : resolvedTheme[key]
                    return (
                      <SettingsRow key={key} label={label}>
                        <ColorPicker
                          value={override ?? fallback ?? ''}
                          fallbackColor={paletteMode === 'dark' ? '#1E1D21' : '#FAF9FB'}
                          onChange={(color) => updatePaletteColor(key, color)}
                          onClear={override ? () => clearPaletteColor(key) : undefined}
                          clearLabel={t('settings.appearance.paletteRestoreColor')}
                          presets={PROJECT_COLOR_PALETTE}
                          ariaLabel={t('settings.appearance.paletteColorAria', { label })}
                          align="end"
                        />
                      </SettingsRow>
                    )
                  })}
                  {customTheme && (
                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        onClick={resetCustomPalette}
                        className="text-xs text-foreground/50 hover:text-foreground transition-colors"
                      >
                        {t('settings.appearance.paletteReset')}
                      </button>
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Workspace Themes */}
              {workspaces.length > 0 && (
                <SettingsSection
                  title={t("settings.appearance.workspaceThemes")}
                  description={t("settings.appearance.workspaceThemesDesc")}
                >
                  <SettingsCard>
                    {workspaces.map((workspace) => {
                      const wsTheme = workspaceThemes[workspace.id]
                      const hasCustomTheme = wsTheme !== undefined
                      return (
                        <SettingsRow
                          key={workspace.id}
                          label={
                            <div className="flex items-center gap-2">
                              <ColorPicker
                                value={workspaceAvatarColors[workspace.id] || ''}
                                onChange={(hex) => setWorkspaceAvatarColor(workspace.id, hex)}
                                onClear={() => clearWorkspaceAvatarColor(workspace.id)}
                                clearLabel={t("settings.appearance.workspaceAvatarReset")}
                                presets={PROJECT_COLOR_PALETTE}
                                ariaLabel={t("settings.appearance.workspaceAvatarColor")}
                                trigger={
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded hover:ring-2 hover:ring-foreground/20 transition-shadow"
                                    aria-label={t("settings.appearance.workspaceAvatarColor")}
                                  >
                                    <WorkspaceAvatar
                                      workspaceId={workspace.id}
                                      workspaceName={workspace.name}
                                      src={workspaceIconMap.get(workspace.id)}
                                      className="w-4 h-4 rounded"
                                    />
                                  </button>
                                }
                              />
                              <span>{workspace.name}</span>
                            </div>
                          }
                        >
                          <SettingsMenuSelect
                            value={hasCustomTheme ? wsTheme : 'default'}
                            onValueChange={(value) => handleWorkspaceThemeChange(workspace.id, value)}
                            options={[
                              { value: 'default', label: appDefaultLabel ? t("settings.appearance.useDefaultWithTheme", { theme: appDefaultLabel }) : t("settings.appearance.useDefault") },
                              ...presetThemes
                                .filter(t => t.id !== 'default')
                                .map(t => ({
                                  value: t.id,
                                  label: t.theme.name || t.id,
                                })),
                            ]}
                          />
                        </SettingsRow>
                      )
                    })}
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Interface */}
              <SettingsSection title={t("settings.appearance.interface")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.appearance.connectionIcons")}
                    description={t("settings.appearance.connectionIconsDesc")}
                    checked={showConnectionIcons}
                    onCheckedChange={handleConnectionIconsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.richToolDescriptions")}
                    description={t("settings.appearance.richToolDescriptionsDesc")}
                    checked={richToolDescriptions}
                    onCheckedChange={handleRichToolDescriptionsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.backgroundFinishedChip")}
                    description={t("settings.appearance.backgroundFinishedChipDesc")}
                    checked={showBackgroundFinishedChip}
                    onCheckedChange={setShowBackgroundFinishedChip}
                  />
                  <SettingsRow
                    label={t("settings.appearance.projectColorTreatment")}
                    description={t("settings.appearance.projectColorTreatmentDesc")}
                  >
                    <SettingsMenuSelect
                      value={projectColorTreatment}
                      onValueChange={handleProjectColorTreatmentChange}
                      options={[
                        { value: 'stripe', label: t("settings.appearance.projectColorStripe") },
                        { value: 'stripe-tint', label: t("settings.appearance.projectColorStripeTint") },
                      ]}
                    />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Kanban board — column colors + live-pulse toggle */}
              <SettingsSection
                title={t("settings.appearance.kanbanBoard")}
                description={t("settings.appearance.kanbanBoardDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => {
                    const merged = kanbanColumnColors[column.id] ?? DEFAULT_KANBAN_COLUMN_COLORS[column.id]
                    return (
                      <SettingsRow key={column.id} label={t(column.labelKey)}>
                        <ColorPicker
                          value={merged}
                          onChange={(hex) => setKanbanColumnColor(column.id, hex)}
                          onClear={kanbanColumnColors[column.id] ? () => resetKanbanColumnColor(column.id) : undefined}
                          clearLabel={t("settings.appearance.kanbanColumnColorReset")}
                          presets={PROJECT_COLOR_PALETTE}
                          ariaLabel={t("settings.appearance.kanbanColumnColor", { column: t(column.labelKey) })}
                          align="end"
                        />
                      </SettingsRow>
                    )
                  })}
                  <SettingsToggle
                    label={t("settings.appearance.kanbanLivePulse")}
                    description={t("settings.appearance.kanbanLivePulseDesc")}
                    checked={kanbanLivePulse}
                    onCheckedChange={setKanbanLivePulse}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Kanban status automation — status applied on drag into a column */}
              <SettingsSection
                title={t("settings.appearance.kanbanColumnStatus")}
                description={t("settings.appearance.kanbanColumnStatusDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => (
                    <SettingsRow key={column.id} label={t(column.labelKey)}>
                      <SettingsMenuSelect
                        value={kanbanColumnStatus[column.id] ?? ''}
                        onValueChange={(value) => setColumnStatus(column.id, value)}
                        options={columnStatusOptions}
                      />
                    </SettingsRow>
                  ))}
                </SettingsCard>
              </SettingsSection>

              {/* Tool Icons — shows the command → icon mapping used in turn cards */}
              <SettingsSection
                title={t("settings.appearance.toolIcons")}
                description={t("settings.appearance.toolIconsDesc")}
                action={
                  toolIconsJsonPath ? (
                    <EditPopover
                      trigger={<EditButton />}
                      {...getEditConfig('edit-tool-icons', toolIconsJsonPath)}
                      secondaryAction={{
                        label: t("settings.appearance.editFile"),
                        filePath: toolIconsJsonPath,
                      }}
                    />
                  ) : undefined
                }
              >
                <SettingsCard>
                  <Info_DataTable
                    columns={toolIconColumns}
                    data={toolIcons}
                    searchable={{ placeholder: t("settings.appearance.searchTools") }}
                    maxHeight={480}
                    emptyContent={t("settings.appearance.noToolIcons")}
                  />
                </SettingsCard>
              </SettingsSection>

            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
