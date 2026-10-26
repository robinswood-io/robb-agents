import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import "@craft-agent/shared/i18n";
import "@/components/app-shell/PanelHeader";
import "@/components/ui/scroll-area";
import "@/components/ui/HeaderMenu";
import "@/lib/utils";
import "@/components/ui/EditPopover";
import { useTheme } from '@/context/ThemeContext';
import { useAppShellContext } from '@/context/AppShellContext';
import "@/lib/navigate";
import "lucide-react";
import "@/components/settings";
import { useAtom } from 'jotai';
import * as storage from '@/lib/local-storage';
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon';
import "@/components/ui/workspace-avatar";
import "@/components/ui/color-picker";
import { workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors';
import { kanbanColumnColorsAtom, kanbanColumnStatusAtom, kanbanLivePulseAtom } from '@/atoms/kanban';
import { showBackgroundFinishedChipAtom } from '@/atoms/background-finished';
import "@/components/app-shell/kanban/status-column";
import "@/components/app-shell/kanban/kanban-colors";
import { setProjectColorTreatment, useProjectColorTreatment } from '@/hooks/useProjectColorTreatment';
import "@/utils/project-colors";
import { SortableHeader } from '@/components/info/Info_DataTable';
import { Info_Badge } from '@/components/info/Info_Badge';

import { AppearanceSettingsContent, type PaletteField } from "./appearance-settings-content";
/**
 * AppearanceSettingsPage
 *
 * Visual customization settings: theme mode, color theme, font,
 * workspace-specific theme overrides, and CLI tool icon mappings.
 */

/**
 * AppearanceSettingsPage
 *
 * Visual customization settings: theme mode, color theme, font,
 * workspace-specific theme overrides, and CLI tool icon mappings.
 */



import type { ColumnDef } from '@/components/ui/data-table';




import type { DetailsPageMeta } from '@/lib/navigation-registry';
import type { ToolIconMapping } from '../../../shared/types';









import type { KanbanColumnId } from '@/components/app-shell/kanban/types';

import { type ProjectColorTreatment } from '@/utils/project-colors';


import type { PresetTheme, ThemeOverrides } from '@config/theme';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'appearance',
}

// ============================================
// Tool Icons Table
// ============================================

/**
 * Column definitions for the tool icon mappings table.
 * Shows a preview icon, tool name, and the CLI commands that trigger it.
 */
const getToolIconColumns = (t: (key: string) => string): ColumnDef<ToolIconMapping>[] => [
  {
    accessorKey: 'iconDataUrl',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.iconHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5">
        <img
          src={row.original.iconDataUrl}
          alt={row.original.displayName}
          className="w-5 h-5 object-contain"
        />
      </div>
    ),
    size: 60,
    enableSorting: false,
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => <SortableHeader column={column} title={t("settings.appearance.toolHeader")} />,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 font-medium">
        {row.original.displayName}
      </div>
    ),
    size: 150,
  },
  {
    accessorKey: 'commands',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.commandsHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 flex flex-wrap gap-1">
        {row.original.commands.map(cmd => (
          <Info_Badge key={cmd} color="muted" className="font-mono">
            {cmd}
          </Info_Badge>
        ))}
      </div>
    ),
    meta: { fillWidth: true },
    enableSorting: false,
  },
]

// ============================================
// Main Component
// ============================================

export default function AppearanceSettingsPage() {
  const { t, i18n } = useTranslation()
  const toolIconColumns = useMemo(() => getToolIconColumns(t), [t])

  const {
    mode,
    setMode,
    colorTheme,
    setColorTheme,
    font,
    setFont,
    activeWorkspaceId,
    setWorkspaceColorTheme,
    themeLoadError,
    themeResolvedFrom,
    resolvedTheme,
    setPreviewColorTheme,
  } = useTheme()
  const { workspaces, sessionStatuses } = useAppShellContext()

  // Fetch workspace icons as data URLs (file:// URLs don't work in renderer)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Preset themes for the color theme dropdown
  const [presetThemes, setPresetThemes] = useState<PresetTheme[]>([])
  const [customTheme, setCustomTheme] = useState<ThemeOverrides | null>(null)
  const [paletteMode, setPaletteMode] = useState<'light' | 'dark'>('dark')

  // Per-workspace theme overrides (workspaceId -> themeId or undefined)
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string | undefined>>({})

  // Tool icon mappings loaded from main process
  const [toolIcons, setToolIcons] = useState<ToolIconMapping[]>([])

  // Resolved path to tool-icons.json (needed for EditPopover and "Edit File" action)
  const [toolIconsJsonPath, setToolIconsJsonPath] = useState<string | null>(null)

  // Connection icon visibility toggle
  const [showConnectionIcons, setShowConnectionIcons] = useState(() =>
    storage.get(storage.KEYS.showConnectionIcons, true)
  )
  const handleConnectionIconsChange = useCallback((checked: boolean) => {
    setShowConnectionIcons(checked)
    storage.set(storage.KEYS.showConnectionIcons, checked)
  }, [])

  // Project color treatment in the SessionList
  const projectColorTreatment = useProjectColorTreatment()
  const handleProjectColorTreatmentChange = useCallback((value: string) => {
    setProjectColorTreatment(value as ProjectColorTreatment)
  }, [])

  // Per-workspace avatar color overrides (persisted in localStorage)
  const [workspaceAvatarColors, setWorkspaceAvatarColors] = useAtom(workspaceAvatarColorsAtom)
  const setWorkspaceAvatarColor = useCallback((workspaceId: string, hex: string) => {
    setWorkspaceAvatarColors(prev => ({ ...prev, [workspaceId]: hex }))
  }, [setWorkspaceAvatarColors])
  const clearWorkspaceAvatarColor = useCallback((workspaceId: string) => {
    setWorkspaceAvatarColors(prev => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
  }, [setWorkspaceAvatarColors])

  // Kanban board appearance (persisted in localStorage via atomWithStorage).
  const [kanbanColumnColors, setKanbanColumnColors] = useAtom(kanbanColumnColorsAtom)
  const setKanbanColumnColor = useCallback((column: KanbanColumnId, hex: string) => {
    setKanbanColumnColors(prev => ({ ...prev, [column]: hex }))
  }, [setKanbanColumnColors])
  const resetKanbanColumnColor = useCallback((column: KanbanColumnId) => {
    setKanbanColumnColors(prev => {
      const next = { ...prev }
      delete next[column]
      return next
    })
  }, [setKanbanColumnColors])
  const [kanbanLivePulse, setKanbanLivePulse] = useAtom(kanbanLivePulseAtom)

  // Per-column status applied when a task is dragged into that column. Empty
  // selection ('') removes the mapping → status left unchanged on move.
  const [kanbanColumnStatus, setKanbanColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const setColumnStatus = useCallback((column: KanbanColumnId, statusId: string) => {
    setKanbanColumnStatus(prev => {
      const next = { ...prev }
      if (statusId) next[column] = statusId
      else delete next[column]
      return next
    })
  }, [setKanbanColumnStatus])
  const columnStatusOptions = useMemo(
    () => [
      { value: '', label: t("settings.appearance.kanbanColumnStatusNone") },
      ...(sessionStatuses ?? []).map(s => ({ value: s.id, label: s.label })),
    ],
    [sessionStatuses, t]
  )

  // Rich tool descriptions toggle (persisted in config.json, read by SDK subprocess)
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)
  useEffect(() => {
    window.electronAPI?.getRichToolDescriptions?.().then(setRichToolDescriptions)
  }, [])
  const handleRichToolDescriptionsChange = useCallback(async (checked: boolean) => {
    setRichToolDescriptions(checked)
    await window.electronAPI?.setRichToolDescriptions?.(checked)
  }, [])

  // "Background session finished" chip toggle (renderer-only appearance pref,
  // persisted in localStorage via atomWithStorage — read by App.tsx + ChatPage).
  const [showBackgroundFinishedChip, setShowBackgroundFinishedChip] = useAtom(showBackgroundFinishedChipAtom)

  // Load preset themes on mount
  useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI) {
        setPresetThemes([])
        return
      }
      try {
        const [themes, override] = await Promise.all([
          window.electronAPI.loadPresetThemes(),
          window.electronAPI.getAppTheme(),
        ])
        setPresetThemes(themes)
        setCustomTheme(override)
      } catch (error) {
        console.error('Failed to load theme settings:', error)
        setPresetThemes([])
      }
    }
    loadThemes()
  }, [])

  const updatePaletteColor = useCallback((field: PaletteField, color: string) => {
    const next: ThemeOverrides = paletteMode === 'dark'
      ? { ...(customTheme ?? {}), dark: { ...(customTheme?.dark ?? {}), [field]: color } }
      : { ...(customTheme ?? {}), [field]: color }
    setCustomTheme(next)
    void window.electronAPI?.setAppTheme(next)
  }, [customTheme, paletteMode])

  const clearPaletteColor = useCallback((field: PaletteField) => {
    const next: ThemeOverrides = { ...(customTheme ?? {}) }
    if (paletteMode === 'dark') {
      const dark = { ...(next.dark ?? {}) }
      delete dark[field]
      if (Object.keys(dark).length > 0) next.dark = dark
      else delete next.dark
    } else {
      delete next[field]
    }
    setCustomTheme(next)
    void window.electronAPI?.setAppTheme(next)
  }, [customTheme, paletteMode])

  const resetCustomPalette = useCallback(() => {
    setCustomTheme(null)
    void window.electronAPI?.clearAppTheme()
  }, [])

  // Load workspace themes on mount
  useEffect(() => {
    const loadWorkspaceThemes = async () => {
      if (!window.electronAPI?.getAllWorkspaceThemes) return
      try {
        const themes = await window.electronAPI.getAllWorkspaceThemes()
        setWorkspaceThemes(themes)
      } catch (error) {
        console.error('Failed to load workspace themes:', error)
      }
    }
    loadWorkspaceThemes()
  }, [])

  // Load tool icon mappings and resolve the config file path on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [mappings, homeDir] = await Promise.all([
          window.electronAPI.getToolIconMappings(),
          window.electronAPI.getHomeDir(),
        ])
        setToolIcons(mappings)
        setToolIconsJsonPath(`${homeDir}/.craft-agent/tool-icons/tool-icons.json`)
      } catch (error) {
        console.error('Failed to load tool icon mappings:', error)
      }
    }
    load()
  }, [])

  // Handler for workspace theme change
  // Uses ThemeContext for the active workspace (immediate visual update) and IPC for other workspaces
  const handleWorkspaceThemeChange = useCallback(
    async (workspaceId: string, value: string) => {
      // 'default' means inherit from app default (null in storage)
      const themeId = value === 'default' ? null : value

      // If changing the current workspace, use context for immediate update
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorTheme(themeId)
      } else {
        // For other workspaces, just persist via IPC
        await window.electronAPI?.setWorkspaceColorTheme?.(workspaceId, themeId)
      }

      // Update local state for UI
      setWorkspaceThemes(prev => ({
        ...prev,
        [workspaceId]: themeId ?? undefined
      }))
    },
    [activeWorkspaceId, setWorkspaceColorTheme]
  )

  // Theme options for dropdowns
  const themeOptions = useMemo(() => [
    { value: 'default', label: t("settings.appearance.useDefault") },
    ...presetThemes
      .filter(t => t.id !== 'default')
      .map(t => ({
        value: t.id,
        label: t.theme.name || t.id,
      })),
  ], [presetThemes, t])

  // Get current app default theme label for display (null when using 'default' to avoid redundant "Use Default (Default)")
  const appDefaultLabel = useMemo(() => {
    if (colorTheme === 'default') return null
    const preset = presetThemes.find(t => t.id === colorTheme)
    return preset?.theme.name || colorTheme
  }, [colorTheme, presetThemes])

  return (
    <AppearanceSettingsContent
      t={t}
      mode={mode}
      setMode={setMode}
      colorTheme={colorTheme}
      setColorTheme={setColorTheme}
      themeOptions={themeOptions}
      font={font}
      setFont={setFont}
      i18n={i18n}
      themeLoadError={themeLoadError}
      themeResolvedFrom={themeResolvedFrom}
      presetThemes={presetThemes}
      setPreviewColorTheme={setPreviewColorTheme}
      paletteMode={paletteMode}
      setPaletteMode={setPaletteMode}
      customTheme={customTheme}
      resolvedTheme={resolvedTheme}
      updatePaletteColor={updatePaletteColor}
      clearPaletteColor={clearPaletteColor}
      resetCustomPalette={resetCustomPalette}
      workspaces={workspaces}
      workspaceThemes={workspaceThemes}
      workspaceAvatarColors={workspaceAvatarColors}
      setWorkspaceAvatarColor={setWorkspaceAvatarColor}
      clearWorkspaceAvatarColor={clearWorkspaceAvatarColor}
      workspaceIconMap={workspaceIconMap}
      handleWorkspaceThemeChange={handleWorkspaceThemeChange}
      appDefaultLabel={appDefaultLabel}
      showConnectionIcons={showConnectionIcons}
      handleConnectionIconsChange={handleConnectionIconsChange}
      richToolDescriptions={richToolDescriptions}
      handleRichToolDescriptionsChange={handleRichToolDescriptionsChange}
      showBackgroundFinishedChip={showBackgroundFinishedChip}
      setShowBackgroundFinishedChip={setShowBackgroundFinishedChip}
      projectColorTreatment={projectColorTreatment}
      handleProjectColorTreatmentChange={handleProjectColorTreatmentChange}
      kanbanColumnColors={kanbanColumnColors}
      setKanbanColumnColor={setKanbanColumnColor}
      resetKanbanColumnColor={resetKanbanColumnColor}
      kanbanLivePulse={kanbanLivePulse}
      setKanbanLivePulse={setKanbanLivePulse}
      kanbanColumnStatus={kanbanColumnStatus}
      setColumnStatus={setColumnStatus}
      columnStatusOptions={columnStatusOptions}
      toolIconsJsonPath={toolIconsJsonPath}
      toolIconColumns={toolIconColumns}
      toolIcons={toolIcons}
    />
  )
}
