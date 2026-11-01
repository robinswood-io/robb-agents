/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import type { Session } from "../../../shared/types";
import type { SessionMeta } from './metadata.ts';

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
export const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

/**
 * Currently active session ID - the session displayed in the main content area
 * This replaces the tab-based session selection
 */
export const activeSessionIdAtom = atom<string | null>(null)

/**
 * Background task for ActiveTasksBar display
 */
/**
 * Lifecycle status of a background task chip.
 * - `running`  — backgrounded, no terminal signal yet (chip shows a spinner + live elapsed).
 * - `completed`/`failed`/`stopped` — a real task_completed notification arrived.
 * - `orphaned` — the turn that owned the task ended before it finished, so it was
 *   terminated with that turn's subprocess. Shown distinctly instead of a false
 *   "running". Not produced once WS2 keep-alive is enabled.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type. 'workflow' = a fan-out Workflow launch (many sub-agents). */
  type: 'agent' | 'shell' | 'workflow'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** Workflow run id (wf_...) — set for type 'workflow'; correlates agent-completed updates. */
  workflowId?: string
  /** Count of sub-agents that have completed so far (type 'workflow' only). */
  agentsCompleted?: number
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events; the chip also derives it from startTime) */
  elapsedSeconds: number
  /** Task intent/description */
  intent?: string
  /** Lifecycle status; defaults to 'running' when added */
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** Output file for click-through, set when task_completed arrives */
  outputFile?: string
  /** Short summary, set when task_completed arrives */
  summary?: string
}

/**
 * Atom family for tracking active background tasks per session
 * Updated on task_backgrounded, shell_backgrounded, task_progress events
 * Cleared when tasks complete or are killed
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
