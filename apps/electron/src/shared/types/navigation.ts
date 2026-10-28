import { isValidSettingsSubpage, type SettingsSubpage } from "../settings-registry";
import type { RightSidebarPanel } from './messaging.ts';

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'flagged' }
  | { kind: 'state'; stateId: string }
  | { kind: 'label'; labelId: string }
  | { kind: 'view'; viewId: string }
  | { kind: 'archived' }

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions'
  filter: SessionFilter
  details: { type: 'session'; sessionId: string } | null
  rightSidebar?: RightSidebarPanel
  /**
   * Presentation mode for the sessions navigator. `'board'` renders the Kanban
   * board (all sessions, grouped into To Do / In Progress / Done columns) in the
   * content area instead of the list + chat. Absent/`'list'` is the default.
   */
  viewMode?: 'list' | 'board'
}

/**
 * Source type filter for sources navigation
 */
export interface SourceFilter {
  kind: 'type'
  sourceType: 'api' | 'mcp' | 'local'
}

/**
 * Automation type filter for automations navigation
 */
export interface AutomationFilter {
  kind: 'type'
  automationType: 'scheduled' | 'event' | 'agentic'
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources'
  filter?: SourceFilter
  details: { type: 'source'; sourceSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Settings navigation state
 *
 * `subpage: null` means the bare `settings` route — navigator-only view in compact
 * mode. On desktop, the content panel falls back to the App page so it isn't empty.
 * Sources/Skills/Automations use `details: null` for the same purpose.
 */
export interface SettingsNavigationState {
  navigator: 'settings'
  subpage: SettingsSubpage | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills'
  details: { type: 'skill'; skillSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Automations navigation state
 */
export interface AutomationsNavigationState {
  navigator: 'automations'
  filter?: AutomationFilter
  details: { type: 'automation'; automationId: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Projects navigation state
 */
export interface ProjectsNavigationState {
  navigator: 'projects'
  details: { type: 'project'; projectSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Workspace-wide Mission OS navigation state.
 *
 * Mission detail remains part of the Control Room instead of opening a chat or
 * introducing another scheduler/source of truth.
 */
export interface MissionsNavigationState {
  navigator: 'missions'
  details: { type: 'mission'; missionId: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | AutomationsNavigationState
  | ProjectsNavigationState
  | MissionsNavigationState

export const isSessionsNavigation = (
  state: NavigationState
): state is SessionsNavigationState => state.navigator === 'sessions'

export const isSourcesNavigation = (
  state: NavigationState
): state is SourcesNavigationState => state.navigator === 'sources'

export const isSettingsNavigation = (
  state: NavigationState
): state is SettingsNavigationState => state.navigator === 'settings'

export const isSkillsNavigation = (
  state: NavigationState
): state is SkillsNavigationState => state.navigator === 'skills'

export const isAutomationsNavigation = (
  state: NavigationState
): state is AutomationsNavigationState => state.navigator === 'automations'

export const isProjectsNavigation = (
  state: NavigationState
): state is ProjectsNavigationState => state.navigator === 'projects'

export const isMissionsNavigation = (
  state: NavigationState
): state is MissionsNavigationState => state.navigator === 'missions'

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}

export const getNavigationStateKey = (state: NavigationState): string => {
  if (state.navigator === 'sources') {
    if (state.details) {
      return `sources/source/${state.details.sourceSlug}`
    }
    return 'sources'
  }
  if (state.navigator === 'skills') {
    if (state.details?.type === 'skill') {
      return `skills/skill/${state.details.skillSlug}`
    }
    return 'skills'
  }
  if (state.navigator === 'automations') {
    if (state.details?.type === 'automation') {
      return `automations/automation/${state.details.automationId}`
    }
    return 'automations'
  }
  if (state.navigator === 'projects') {
    if (state.details?.type === 'project') {
      return `projects/project/${state.details.projectSlug}`
    }
    return 'projects'
  }
  if (state.navigator === 'missions') {
    if (state.details?.type === 'mission') {
      return `missions/mission/${state.details.missionId}`
    }
    return 'missions'
  }
  if (state.navigator === 'settings') {
    if (state.subpage === null) return 'settings'
    return `settings:${state.subpage}`
  }
  // Chats
  const f = state.filter
  let base: string
  if (f.kind === 'state') base = `state:${f.stateId}`
  else if (f.kind === 'label') base = `label:${f.labelId}`
  else if (f.kind === 'view') base = `view:${f.viewId}`
  else base = f.kind
  if (state.details) {
    return `${base}/chat/${state.details.sessionId}`
  }
  return base
}

export const parseNavigationStateKey = (key: string): NavigationState | null => {
  // Handle sources
  if (key === 'sources') return { navigator: 'sources', details: null }
  if (key.startsWith('sources/source/')) {
    const sourceSlug = key.slice(15)
    if (sourceSlug) {
      return { navigator: 'sources', details: { type: 'source', sourceSlug } }
    }
    return { navigator: 'sources', details: null }
  }

  // Handle skills
  if (key === 'skills') return { navigator: 'skills', details: null }
  if (key.startsWith('skills/skill/')) {
    const skillSlug = key.slice(13)
    if (skillSlug) {
      return { navigator: 'skills', details: { type: 'skill', skillSlug } }
    }
    return { navigator: 'skills', details: null }
  }

  // Handle automations
  if (key === 'automations') return { navigator: 'automations', details: null }
  if (key.startsWith('automations/automation/')) {
    const automationId = key.slice(22)
    if (automationId) {
      return { navigator: 'automations', details: { type: 'automation', automationId } }
    }
    return { navigator: 'automations', details: null }
  }

  // Handle projects
  if (key === 'projects') return { navigator: 'projects', details: null }
  if (key.startsWith('projects/project/')) {
    const projectSlug = key.slice(17)
    if (projectSlug) {
      return { navigator: 'projects', details: { type: 'project', projectSlug } }
    }
    return { navigator: 'projects', details: null }
  }

  // Handle missions
  if (key === 'missions') return { navigator: 'missions', details: null }
  if (key.startsWith('missions/mission/')) {
    const missionId = key.slice(17)
    if (missionId) {
      return { navigator: 'missions', details: { type: 'mission', missionId } }
    }
    return { navigator: 'missions', details: null }
  }

  // Handle settings
  if (key === 'settings') return { navigator: 'settings', subpage: null }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9)
    if (isValidSettingsSubpage(subpage)) {
      return { navigator: 'settings', subpage }
    }
  }

  // Handle sessions
  const parseSessionsKey = (filterKey: string, sessionId?: string): NavigationState | null => {
    let filter: SessionFilter
    if (filterKey === 'allSessions') filter = { kind: 'allSessions' }
    else if (filterKey === 'flagged') filter = { kind: 'flagged' }
    else if (filterKey === 'archived') filter = { kind: 'archived' }
    else if (filterKey.startsWith('state:')) {
      const stateId = filterKey.slice(6)
      if (!stateId) return null
      filter = { kind: 'state', stateId }
    } else if (filterKey.startsWith('label:')) {
      const labelId = filterKey.slice(6)
      if (!labelId) return null
      filter = { kind: 'label', labelId }
    } else if (filterKey.startsWith('view:')) {
      const viewId = filterKey.slice(5)
      if (!viewId) return null
      filter = { kind: 'view', viewId }
    } else {
      return null
    }
    return {
      navigator: 'sessions',
      filter,
      details: sessionId ? { type: 'session', sessionId } : null,
    }
  }

  // Check for session details
  if (key.includes('/session/')) {
    const [filterPart, , sessionId] = key.split('/')
    return filterPart ? parseSessionsKey(filterPart, sessionId) : null
  }

  // Simple filter key
  return parseSessionsKey(key)
}
