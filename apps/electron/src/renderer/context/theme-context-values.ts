import { createContext, type ReactNode } from 'react';
import * as storage from '@/lib/local-storage';
import { type ThemeOverrides, type ThemeFile, type ShikiThemeConfig } from '@config/theme';


export type ThemeMode = 'light' | 'dark' | 'system'

export type FontFamily = 'inter' | 'system'


export interface ThemeContextType {
  // Preferences (persisted at app level)
  mode: ThemeMode
  /** App-level default color theme (used when workspace has no override) */
  colorTheme: string
  font: FontFamily
  setMode: (mode: ThemeMode) => void
  /** Set app-level default color theme */
  setColorTheme: (theme: string) => void
  setFont: (font: FontFamily) => void

  // Workspace-level theme override
  /** Active workspace ID (null if no workspace context) */
  activeWorkspaceId: string | null
  /** Workspace-specific color theme override (null = inherit from app default) */
  workspaceColorTheme: string | null
  /** Set workspace-specific color theme override (null = inherit) */
  setWorkspaceColorTheme: (theme: string | null) => void

  // Derived/computed
  resolvedMode: 'light' | 'dark'
  systemPreference: 'light' | 'dark'
  /** Effective color theme for rendering (previewColorTheme ?? workspaceColorTheme ?? colorTheme) */
  effectiveColorTheme: string
  /** Temporary preview theme (hover state) - not persisted */
  previewColorTheme: string | null
  /** Set temporary preview theme for hover preview. Pass null to clear. */
  setPreviewColorTheme: (theme: string | null) => void
  /** Where effectiveColorTheme came from for current render cycle */
  effectiveColorThemeSource: 'preview' | 'workspace' | 'app'
  /** How the preset theme was resolved */
  themeResolvedFrom: 'none' | 'ipc' | 'fallback'
  /** Non-fatal theme loading error. Null when theme loaded normally. */
  themeLoadError: string | null

  // Theme resolution (singleton - loaded once)
  /** Loaded preset theme file, null if default or loading */
  presetTheme: ThemeFile | null
  /** Fully resolved theme (preset merged with any overrides) */
  resolvedTheme: ThemeOverrides
  /** Whether dark mode is active (scenic themes force dark) */
  isDark: boolean
  /** Whether theme is scenic mode (background image with glass panels) */
  isScenic: boolean
  /** Shiki syntax highlighting theme name for current mode */
  shikiTheme: string
  /** Shiki theme configuration (light/dark variants) */
  shikiConfig: ShikiThemeConfig
}


export interface StoredTheme {
  mode: ThemeMode
  colorTheme: string
  font?: FontFamily
  /** True when user explicitly changed theme in UI (not auto-saved on startup) */
  isUserOverride?: boolean
}


export const ThemeContext = createContext<ThemeContextType | undefined>(undefined)


export const bundledThemeModules = import.meta.glob('../../../resources/themes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, ThemeFile>


export const BUNDLED_THEMES = new Map<string, ThemeFile>(
  Object.entries(bundledThemeModules).map(([path, theme]) => {
    const fileName = path.split('/').pop() ?? ''
    const id = fileName.replace('.json', '')
    return [id, theme]
  })
)


export interface ThemeProviderProps {
  children: ReactNode
  defaultMode?: ThemeMode | undefined
  defaultColorTheme?: string | undefined
  defaultFont?: FontFamily | undefined
  /** Active workspace ID for workspace-level theme overrides */
  activeWorkspaceId?: string | null | undefined
}


export function getSystemPreference(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}


export function loadStoredTheme(): StoredTheme | null {
  if (typeof window === 'undefined') return null
  return storage.get<StoredTheme | null>(storage.KEYS.theme, null)
}


export function saveTheme(theme: StoredTheme): void {
  storage.set(storage.KEYS.theme, theme)
}
