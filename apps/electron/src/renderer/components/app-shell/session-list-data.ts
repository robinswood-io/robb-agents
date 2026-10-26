

import { isToday, isYesterday, format, startOfDay } from "date-fns";
import { getDateLocale } from "@craft-agent/shared/i18n";

import { getSessionStatus } from "@/utils/session";

import type { LabelConfig } from "@craft-agent/shared/labels";

import { type EntityListGroup } from "@/components/ui/entity-list";

import { type FilterMode } from "@/hooks/useSessionSearch";

import { type SessionMeta } from "@/atoms/sessions";
import type { ViewConfig } from "@craft-agent/shared/views";
import type { SessionStatusId, SessionStatus } from "@/config/session-status-config";

export interface SessionListRow {
  item: SessionMeta
}


/** Grouping mode for chat list */
export type ChatGroupingMode = 'date' | 'status' | 'unread' | 'project'


export interface SessionListProps {
  items: SessionMeta[]
  /** Full workspace family used only to project delegated activity onto visible parents. */
  relatedItems?: SessionMeta[]
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onRename: (sessionId: string, name: string) => void
  /** Called when Enter is pressed to focus chat input for a specific session */
  onFocusChatInput?: (sessionId?: string) => void
  /** Called when a session is selected */
  onSessionSelect?: (session: SessionMeta) => void
  /** Called when user wants to open a session in a new window */
  onOpenInNewWindow?: (session: SessionMeta) => void
  /** Called to navigate to a specific view (e.g., 'allSessions', 'flagged') */
  onNavigateToView?: (view: 'allSessions' | 'flagged') => void
  /** Unified session options per session (real-time state) */
  sessionOptions?: Map<string, import('../../hooks/useSessionOptions').SessionOptions>
  /** Whether search mode is active */
  searchActive?: boolean
  /** Current search query */
  searchQuery?: string
  /** Called when search query changes */
  onSearchChange?: (query: string) => void
  /** Called when search is closed */
  onSearchClose?: () => void
  /** Dynamic todo states from workspace config */
  sessionStatuses?: SessionStatus[]
  /** View evaluator — evaluates a session and returns matching view configs */
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  /** Label configs for resolving session label IDs to display info */
  labels?: LabelConfig[]
  /** Callback when session labels are toggled (for labels submenu in SessionMenu) */
  onLabelsChange?: (sessionId: string, labels: string[]) => void
  /** Quick filter/toggle sessions by a specific label */
  onToggleLabelFilter?: (labelId: string) => void
  /** Workspace projects (for the Projects submenu in SessionMenu) */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  /** Callback to bind/unbind a session to a project (null = unbind) */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** How to group sessions: 'date' (default) or 'status' */
  groupingMode?: ChatGroupingMode
  /** Workspace ID for content search (optional - if not provided, content search is disabled) */
  workspaceId?: string
  /** Secondary status filter (status chips in "All Sessions" view) - for search result grouping */
  statusFilter?: Map<string, FilterMode>
  /** Secondary label filter (label chips) - for search result grouping */
  labelFilterMap?: Map<string, FilterMode>
  /** Override which session is highlighted (for multi-panel focused panel tracking) */
  focusedSessionId?: string | null
  /** Override navigation target (for multi-panel: focuses existing panel or navigates focused panel) */
  onNavigateToSession?: (sessionId: string) => void
  /** Session-level pending prompt marker (permission/admin approval) */
  hasPendingPrompt?: (sessionId: string) => boolean
  /** DOM-verified match info for the active session (from ChatDisplay) */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
}


// Note: uses date-fns format for non-today/yesterday dates; Today/Yesterday translated at render time
function formatDateGroupLabel(date: Date, t: (key: string) => string, lang: string): string {
  if (isToday(date)) return t('common.today')
  if (isYesterday(date)) return t('common.yesterday')
  return format(date, 'MMM d', { locale: getDateLocale(lang) })
}

interface SessionListRowsInput {
  isSearchMode: boolean
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  t: import("i18next").TFunction<"translation", undefined>
  flatItems: SessionMeta[]
  groupingMode: ChatGroupingMode
  collapsedGroupsMeta: import("@/hooks/useSessionSearch").CollapsedGroupMeta[]
  sessionStatuses: SessionStatus[]
  projects: { id: string; slug: string; name: string; color?: string; }[] | undefined
  i18n: import("i18next").i18n
}

export function buildSessionListRows({
  isSearchMode,
  matchingFilterItems,
  otherResultItems,
  t,
  flatItems,
  groupingMode,
  collapsedGroupsMeta,
  sessionStatuses,
  projects,
  i18n,
}: SessionListRowsInput) {
    if (isSearchMode) {
      const matchingRows = matchingFilterItems.map(item => ({ item }))
      const otherRows = otherResultItems.map(item => ({ item }))

      const groups: EntityListGroup<SessionListRow>[] = []
      if (matchingRows.length > 0) {
        groups.push({ key: 'matching', label: t("session.inCurrentView"), items: matchingRows })
      }
      if (otherRows.length > 0) {
        groups.push({ key: 'other', label: t("session.otherConversations"), items: otherRows })
      }

      return {
        rows: groups.flatMap(g => g.items),
        groups,
      }
    }

    // flatItems only contains visible (expanded + paginated) items.
    // collapsedGroupsMeta provides key + count for collapsed groups so we
    // can insert header-only placeholder groups in the correct position.
    const rows: SessionListRow[] = flatItems.map(item => ({ item }))

    if (groupingMode === 'unread') {
      // Two fixed buckets: unread on top, read below. Within each, items keep
      // the same `lastMessageAt`-descending order they already arrive in.
      // Both buckets always render — even when empty — so the user can see at
      // a glance which mode they're in. The header shows a count, so an empty
      // bucket is unambiguous (e.g. "Unread (0)").
      const unreadRows: SessionListRow[] = []
      const readRows: SessionListRow[] = []
      for (const row of rows) {
        if (row.item.hasUnread) unreadRows.push(row)
        else readRows.push(row)
      }
      unreadRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
      readRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
      const collapsedUnread = collapsedGroupsMeta.find(m => m.key === 'unread-yes')
      const collapsedRead = collapsedGroupsMeta.find(m => m.key === 'unread-no')

      // For collapsed groups prefer the persisted count (matches how the
      // date/status branches surface the size of a collapsed bucket).
      const unreadCount = collapsedUnread ? collapsedUnread.count : unreadRows.length
      const readCount = collapsedRead ? collapsedRead.count : readRows.length

      const orderedGroups: EntityListGroup<SessionListRow>[] = [
        {
          key: 'unread-yes',
          label: t('session.unreadGroup', { count: unreadCount }),
          items: unreadRows,
          // Empty groups have nothing to collapse into; suppress the caret.
          collapsible: unreadRows.length > 0 || !!collapsedUnread,
          ...(collapsedUnread ? { collapsedCount: collapsedUnread.count } : {}),
        },
        {
          key: 'unread-no',
          label: t('session.readGroup', { count: readCount }),
          items: readRows,
          collapsible: readRows.length > 0 || !!collapsedRead,
          ...(collapsedRead ? { collapsedCount: collapsedRead.count } : {}),
        },
      ]

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    if (groupingMode === 'status') {
      const statusOrder = new Map<string, number>()
      sessionStatuses.forEach((state, index) => statusOrder.set(state.id, index))

      // Build groups from visible items
      const groupsByKey = new Map<string, { rows: SessionListRow[], statusId: string }>()
      for (const row of rows) {
        const statusId = getSessionStatus(row.item)
        const key = `status-${statusId}`
        if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], statusId })
        groupsByKey.get(key)!.rows.push(row)
      }

      // Insert collapsed placeholder groups
      for (const meta of collapsedGroupsMeta) {
        if (!groupsByKey.has(meta.key)) {
          const statusId = meta.key.replace('status-', '')
          groupsByKey.set(meta.key, { rows: [], statusId })
        }
      }

      const orderedGroups: EntityListGroup<SessionListRow>[] = []
      for (const [key, { rows: groupRows, statusId }] of groupsByKey) {
        const state = sessionStatuses.find(s => s.id === statusId)
        if (!state) continue
        groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
        const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
        orderedGroups.push({
          key,
          label: t(`status.${state.id}`, state.label),
          items: groupRows,
          collapsible: true,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        })
      }
      orderedGroups.sort((a, b) => {
        const aOrder = statusOrder.get(a.key.replace('status-', '')) ?? 999
        const bOrder = statusOrder.get(b.key.replace('status-', '')) ?? 999
        return aOrder - bOrder
      })

      // If only one group exists, disable collapsing — there's nothing to collapse into
      if (orderedGroups.length === 1) {
        orderedGroups[0].collapsible = false
      }

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    if (groupingMode === 'project') {
      // Build groups from visible items, bucketed by projectId.
      // Sessions without a projectId (or with an unknown projectId) go to the
      // "no-project" bucket so they're never silently dropped from the list.
      const projectOrder = new Map<string, number>()
      ;(projects ?? []).forEach((p, index) => projectOrder.set(p.id, index))
      const projectNameById = new Map<string, string>()
      ;(projects ?? []).forEach(p => projectNameById.set(p.id, p.name))

      const groupsByKey = new Map<string, { rows: SessionListRow[], projectId: string | null }>()
      for (const row of rows) {
        const rawProjectId = (row.item as { projectId?: string }).projectId
        const resolvedProjectId = rawProjectId && projectNameById.has(rawProjectId) ? rawProjectId : null
        const key = resolvedProjectId ? `project-${resolvedProjectId}` : 'project-__none__'
        if (!groupsByKey.has(key)) groupsByKey.set(key, { rows: [], projectId: resolvedProjectId })
        groupsByKey.get(key)!.rows.push(row)
      }

      // Insert collapsed placeholder groups (header-only, items: [])
      for (const meta of collapsedGroupsMeta) {
        if (!groupsByKey.has(meta.key)) {
          const idPart = meta.key.replace('project-', '')
          const projectId = idPart === '__none__' ? null : idPart
          groupsByKey.set(meta.key, { rows: [], projectId })
        }
      }

      const orderedGroups: EntityListGroup<SessionListRow>[] = []
      for (const [key, { rows: groupRows, projectId }] of groupsByKey) {
        groupRows.sort((a, b) => (b.item.lastMessageAt || 0) - (a.item.lastMessageAt || 0))
        const collapsedMeta = collapsedGroupsMeta.find(m => m.key === key)
        const label = projectId
          ? (projectNameById.get(projectId) ?? t('sidebar.unknownProject', { defaultValue: 'Unknown project' }))
          : t('sidebar.noProject', { defaultValue: 'No project' })
        orderedGroups.push({
          key,
          label,
          items: groupRows,
          collapsible: true,
          ...(collapsedMeta ? { collapsedCount: collapsedMeta.count } : {}),
        })
      }
      orderedGroups.sort((a, b) => {
        // No-project bucket sinks to the bottom, configured projects in registration order
        if (a.key === 'project-__none__') return 1
        if (b.key === 'project-__none__') return -1
        const aOrder = projectOrder.get(a.key.replace('project-', '')) ?? 999
        const bOrder = projectOrder.get(b.key.replace('project-', '')) ?? 999
        return aOrder - bOrder
      })

      if (orderedGroups.length === 1) {
        orderedGroups[0].collapsible = false
      }

      return {
        rows: orderedGroups.flatMap(g => g.items),
        groups: orderedGroups,
      }
    }

    // Default: group by date
    const groupsByKey = new Map<string, EntityListGroup<SessionListRow>>()
    const groupDates = new Map<string, Date>()

    for (const row of rows) {
      const day = startOfDay(new Date(row.item.lastMessageAt || 0))
      const groupKey = day.toISOString()

      if (!groupsByKey.has(groupKey)) {
        groupsByKey.set(groupKey, {
          key: groupKey,
          label: formatDateGroupLabel(day, t, i18n.resolvedLanguage ?? 'en'),
          items: [],
          collapsible: true,
        })
        groupDates.set(groupKey, day)
      }
      groupsByKey.get(groupKey)!.items.push(row)
    }

    // Insert collapsed placeholder groups (header-only, items: [])
    for (const meta of collapsedGroupsMeta) {
      if (!groupsByKey.has(meta.key)) {
        const date = new Date(meta.key)
        groupsByKey.set(meta.key, {
          key: meta.key,
          label: formatDateGroupLabel(date, t, i18n.resolvedLanguage ?? 'en'),
          items: [],
          collapsible: true,
          collapsedCount: meta.count,
        })
        groupDates.set(meta.key, date)
      }
    }

    // Sort all groups by date descending
    const orderedKeys = Array.from(groupDates.entries())
      .sort(([, a], [, b]) => b.getTime() - a.getTime())
      .map(([key]) => key)

    const orderedGroups = orderedKeys.map(key => groupsByKey.get(key)!)

    // If only one group exists, disable collapsing — there's nothing to collapse into
    if (orderedGroups.length === 1) {
      orderedGroups[0].collapsible = false
    }

    return {
      rows: orderedGroups.flatMap(g => g.items),
      groups: orderedGroups,
    }
  }
