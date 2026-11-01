import { Sortable } from "@dnd-kit/dom/sortable";

export type TaskState = 'todo' | 'in_progress' | 'done' | 'cancelled'

export type SyncState = 'local_only' | 'pending_upload' | 'uploaded' | 'remote_only' | 'unavailable' | 'upload_failed'

type PlannerEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.cancelled'
  | 'task.reopened'
  | 'task.moved'
  | 'task.session_linked'
  | 'task.session_unlinked'
  | 'task.session_snapshot_updated'

export type PlannerRow =
  | { kind: 'heading'; headingId: string; key: string }
  | { kind: 'task'; taskId: string; key: string }

export interface SessionSnapshot {
  id: string
  title: string
  summary: string
  lastUpdated: string
}

export interface TaskSessionLinkLocal {
  id: string
  taskId: string
  snapshotId: string
  syncState: SyncState
}

export interface PlannerTaskEvent {
  id: string
  taskId: string
  type: PlannerEventType
  at: string
  actor: string
  payloadSummary: string
}

export interface PlannerTask {
  id: string
  headingId: string
  title: string
  notes: string
  state: TaskState
  due: string
}

export interface PlannerHeading {
  id: string
  projectId: string
  title: string
  sortOrder: number
}

export interface PlannerProject {
  id: string
  name: string
  status: 'open' | 'archived'
  sortOrder: number
  installationHint: string
  memberCount: number
}

export interface PlannerSortableEntry {
  sortable: Sortable
  element: HTMLDivElement
  index: number
}
