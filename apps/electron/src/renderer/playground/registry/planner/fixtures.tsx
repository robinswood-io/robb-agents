import * as React from "react";
import { CloudAlert, CloudCheck, CloudOff, CloudUpload } from "lucide-react";
import type { PlannerProject, PlannerHeading, PlannerTask, SessionSnapshot, TaskSessionLinkLocal, PlannerTaskEvent, TaskState, SyncState } from "./models";

export const projects: PlannerProject[] = [
  { id: 'p1', name: 'Personal', status: 'open', sortOrder: 1, installationHint: 'MacBook · my-workspace', memberCount: 1 },
  { id: 'p2', name: 'Planner V2', status: 'open', sortOrder: 2, installationHint: 'MacBook · my-workspace', memberCount: 3 },
  { id: 'p3', name: 'Craft App', status: 'open', sortOrder: 3, installationHint: 'Import mounted locally', memberCount: 4 },
  { id: 'p4', name: 'Markdown Samples', status: 'open', sortOrder: 4, installationHint: 'Editor test fixtures', memberCount: 1 },
]

export const initialHeadings: PlannerHeading[] = [
  { id: 'h1', projectId: 'p2', title: 'Today', sortOrder: 1 },
  { id: 'h2', projectId: 'p2', title: 'Upcoming', sortOrder: 2 },
  { id: 'h3', projectId: 'p2', title: 'Later', sortOrder: 3 },
  { id: 'h4', projectId: 'p4', title: 'Diagrams & Visuals', sortOrder: 1 },
  { id: 'h5', projectId: 'p4', title: 'Code & Math', sortOrder: 2 },
  { id: 'h6', projectId: 'p4', title: 'Long-form & Mixed', sortOrder: 3 },
]

export const initialTasks: PlannerTask[] = [
  {
    id: 't1',
    headingId: 'h1',
    title: 'Build planner shell in playground',
    notes: 'Three-pane layout with **projects**, **headings**, **tasks**, and detail view.\n\n## Requirements\n- Keep rhythm calm and lightweight\n- Panels should match the main app chrome\n- Resize handles with gradient feedback\n\n> The detail pane should feel like Linear\'s issue view.',
    state: 'in_progress',
    due: 'Today · 21:00',
  },
  {
    id: 't2',
    headingId: 'h1',
    title: 'Add linked session cards with sync-state badges',
    notes: 'Snapshots should remain useful even if session cannot be resolved.\n\n**Sync states:**\n1. `local_only` — not yet uploaded\n2. `pending_upload` — queued for sync\n3. `uploaded` — confirmed on server\n4. `remote_only` — server-side only\n5. `unavailable` — session deleted\n6. `upload_failed` — retry needed',
    state: 'todo',
    due: 'Today · 22:00',
  },
  {
    id: 't5',
    headingId: 'h1',
    title: 'Wire up drag-to-reorder between headings',
    notes: 'Tasks dragged across heading boundaries should update their headingId.',
    state: 'done',
    due: 'Today · 14:00',
  },
  {
    id: 't6',
    headingId: 'h1',
    title: 'Keyboard navigation for task list',
    notes: 'Arrow keys to move selection, Enter to open detail, Escape to deselect.',
    state: 'todo',
    due: 'Today · 23:00',
  },
  {
    id: 't7',
    headingId: 'h1',
    title: 'Quick-add input autofocus on Cmd+N',
    notes: 'Global shortcut should focus the input and select all text.',
    state: 'done',
    due: 'Today · 12:00',
  },
  {
    id: 't3',
    headingId: 'h2',
    title: 'Task timeline tab with append-only events',
    notes: 'Map event types from task_events table to readable timeline rows.',
    state: 'todo',
    due: 'Tomorrow',
  },
  {
    id: 't8',
    headingId: 'h2',
    title: 'Portable core: SQLite schema for tasks + headings',
    notes: 'Design tables with **WAL mode**, CRDT-friendly IDs, and `sort_order` columns.\n\n### Tables\n- `tasks` — id, title, notes, state, heading_id, sort_order\n- `headings` — id, title, project_id, sort_order\n- `task_events` — id, task_id, type, payload, created_at\n- `task_session_links` — id, task_id, snapshot_id, sync_state',
    state: 'todo',
    due: 'Tomorrow',
  },
  {
    id: 't9',
    headingId: 'h2',
    title: 'Sync engine: conflict resolution strategy',
    notes: 'Last-write-wins per field with vector clocks.\n\n## Trade-offs\n- **LWW** is simple but can lose concurrent edits\n- **CRDTs** are correct but add complexity\n- *Hybrid*: LWW for scalar fields, CRDT for lists (sort_order)\n\n> Start with LWW and add conflict UI later if needed.',
    state: 'todo',
    due: 'Mar 2',
  },
  {
    id: 't10',
    headingId: 'h2',
    title: 'Session snapshot auto-refresh on task open',
    notes: 'When a task with linked sessions is selected, refresh stale snapshots in background.',
    state: 'todo',
    due: 'Mar 3',
  },
  {
    id: 't11',
    headingId: 'h2',
    title: 'Due date picker with natural language input',
    notes: 'Parse "tomorrow", "next friday", "in 3 days" into actual dates.',
    state: 'todo',
    due: 'Mar 4',
  },
  {
    id: 't4',
    headingId: 'h3',
    title: 'Project sharing UX (members + roles)',
    notes: 'Project ACL root with owner/editor/viewer hints.',
    state: 'cancelled',
    due: 'Next week',
  },
  {
    id: 't12',
    headingId: 'h3',
    title: 'Multi-workspace task views',
    notes: 'Aggregate tasks from multiple workspaces into a unified "My Tasks" view.',
    state: 'todo',
    due: 'Mar 10',
  },
  {
    id: 't13',
    headingId: 'h3',
    title: 'Recurring tasks with cron-like schedules',
    notes: 'Support daily, weekly, monthly recurrence with skip/snooze options.',
    state: 'todo',
    due: 'Mar 15',
  },
  {
    id: 't14',
    headingId: 'h3',
    title: 'Task templates from session transcripts',
    notes: 'Extract action items from a session and create tasks with pre-filled notes.',
    state: 'todo',
    due: 'Mar 20',
  },
  {
    id: 't15',
    headingId: 'h3',
    title: 'Archive completed tasks after 7 days',
    notes: 'Auto-archive with undo. Archived tasks visible in a separate filtered view.',
    state: 'todo',
    due: 'Later',
  },
  {
    id: 't16',
    headingId: 'h3',
    title: 'Notification badges for overdue tasks',
    notes: 'Red dot on project sidebar item when tasks are past due.',
    state: 'todo',
    due: 'Later',
  },
  // ── Markdown Samples project (p4) ──
  {
    id: 'ms1',
    headingId: 'h4',
    title: 'Mermaid: Data flow diagram',
    notes: 'Document the full data pipeline from user action to persistence.\n\n```mermaid\ngraph LR\n    A[User Action] --> B[React State]\n    B --> C[SQLite WAL]\n    C --> D[Sync Engine]\n    D --> E[Remote API]\n    E --> F[Conflict Resolution]\n    F --> C\n```\n\n![Planner pipeline board mock](https://picsum.photos/seed/planner-pipeline/1200/620 "Planner pipeline mock")\n\nThe sync engine should handle **offline-first** writes and queue them for upload when connectivity resumes.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms2',
    headingId: 'h4',
    title: 'Mermaid: State machine',
    notes: 'Task lifecycle as a state diagram.\n\n```mermaid\nstateDiagram-v2\n    [*] --> todo\n    todo --> in_progress: Start\n    in_progress --> done: Complete\n    in_progress --> todo: Pause\n    todo --> cancelled: Cancel\n    in_progress --> cancelled: Cancel\n    done --> todo: Reopen\n    cancelled --> todo: Reopen\n```\n\nEvery transition emits an **event** to the append-only `task_events` table.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms3',
    headingId: 'h4',
    title: 'Mermaid: Sequence diagram',
    notes: 'Sync protocol between client and server.\n\n```mermaid\nsequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: POST /sync (events[])\n    S-->>C: 200 OK (ack + remote events)\n    C->>C: Apply remote events\n    C->>C: Resolve conflicts (LWW)\n    Note over C,S: Retry with exponential backoff on failure\n```',
    state: 'done',
    due: '',
  },
  {
    id: 'ms4',
    headingId: 'h5',
    title: 'Code: TypeScript — Fractional indexing',
    notes: 'Use fractional indexing for `sort_order` to avoid renumbering on every reorder.\n\n```typescript\nfunction midpoint(a: string, b: string): string {\n  // Generate a string between a and b lexicographically\n  const aCode = a.charCodeAt(0) || 96 // \'a\' - 1\n  const bCode = b.charCodeAt(0) || 123 // \'z\' + 1\n  const mid = Math.floor((aCode + bCode) / 2)\n  if (mid === aCode) {\n    return a + String.fromCharCode(\n      Math.floor((97 + (b.charCodeAt(1) || 123)) / 2)\n    )\n  }\n  return String.fromCharCode(mid)\n}\n```\n\n### Edge cases\n- Inserting at the very beginning (before `\"a\"`)\n- Inserting at the very end (after `\"z\"`)\n- Exhausting the single-char keyspace → must extend with a second character\n\n> See also: [Implementing Fractional Indexing](https://observablehq.com/@dgreensp/implementing-fractional-indexing) by David Greenspan.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms5',
    headingId: 'h5',
    title: 'Code: SQL — Query benchmarks',
    notes: 'Benchmark the critical SQLite queries.\n\n```sql\n-- Tasks by heading (hot path)\nSELECT id, title, state, sort_order\nFROM tasks\nWHERE heading_id = ?\nORDER BY sort_order;\n\n-- Overdue tasks across all projects\nSELECT t.id, t.title, t.due_at, h.title AS heading\nFROM tasks t\nJOIN headings h ON h.id = t.heading_id\nWHERE t.due_at < datetime(\'now\')\n  AND t.state NOT IN (\'done\', \'cancelled\')\nORDER BY t.due_at ASC;\n\n-- Event timeline for a task\nSELECT type, payload, created_at\nFROM task_events\nWHERE task_id = ?\nORDER BY created_at DESC\nLIMIT 50;\n```\n\nTarget: all queries under **5ms** with indices on `heading_id`, `due_at`, and `task_id`.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms6',
    headingId: 'h5',
    title: 'Code: JSON — API contract',
    notes: 'REST API surface for task CRUD.\n\n```json\n{\n  "POST /tasks": {\n    "body": { "title": "string", "headingId": "string", "notes?": "string" },\n    "response": { "id": "string", "createdAt": "ISO8601" }\n  },\n  "PATCH /tasks/:id": {\n    "body": { "title?": "string", "state?": "TaskState", "notes?": "string" },\n    "response": { "updatedAt": "ISO8601" }\n  },\n  "DELETE /tasks/:id": {\n    "response": 204\n  }\n}\n```\n\nAll mutations return an `ETag` header for **optimistic concurrency control**.',
    state: 'done',
    due: '',
  },
  {
    id: 'ms7',
    headingId: 'h5',
    title: 'Math: Priority scoring formula',
    notes: 'Design a priority scoring system that combines urgency and importance.\n\nThe **Eisenhower weight** can be modeled as:\n\n$$P = w_u \\cdot U + w_i \\cdot I + \\lambda \\cdot e^{-\\Delta t / \\tau}$$\n\nWhere:\n- $$U$$ = urgency score (0–10)\n- $$I$$ = importance score (0–10)\n- $$\\Delta t$$ = time until due date\n- $$\\tau$$ = decay constant (e.g. 7 days)\n- $$w_u, w_i$$ = tunable weights\n- $$\\lambda$$ = deadline pressure coefficient\n\nDefault weights: $$w_u = 0.4$$, $$w_i = 0.6$$, $$\\lambda = 2.0$$, $$\\tau = 7$$.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms8',
    headingId: 'h5',
    title: 'Math: Information entropy',
    notes: 'Shannon entropy for measuring task distribution across headings.\n\n$$H(X) = -\\sum_{i=1}^{n} p(x_i) \\log_2 p(x_i)$$\n\nFor a balanced distribution across $$n$$ headings:\n\n$$H_{max} = \\log_2(n)$$\n\nAn **imbalance score** can be derived as:\n\n$$\\text{imbalance} = 1 - \\frac{H(X)}{H_{max}}$$\n\nValues close to 0 mean tasks are evenly spread; close to 1 means everything is piled in one section.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms9',
    headingId: 'h6',
    title: 'Long-form: Full architecture spec',
    notes: '# Planner V2 Architecture\n\nThis document outlines the **complete architecture** for the Planner V2 system.\n\n## Overview\n\nThe planner is a *three-layer* system:\n\n1. **Presentation layer** — React components with Tiptap editors\n2. **State layer** — SQLite with WAL mode, exposed via typed queries\n3. **Sync layer** — Offline-first CRDT sync with conflict resolution\n\n![Architecture concept sketch](https://picsum.photos/seed/planner-arch-spec/1280/720 "Architecture concept")\n\n## Data Model\n\nCore entities:\n- **Project** — top-level container with ACL\n- **Heading** — ordered sections within a project\n- **Task** — individual work items with state machine\n- **Event** — append-only audit log\n- **SessionLink** — references to agent sessions\n\n## Task State Machine\n\n```mermaid\nstateDiagram-v2\n    [*] --> todo\n    todo --> in_progress: Start\n    in_progress --> done: Complete\n    in_progress --> todo: Pause\n    todo --> cancelled: Cancel\n    in_progress --> cancelled: Cancel\n    done --> todo: Reopen\n    cancelled --> todo: Reopen\n```\n\n## Sync Protocol\n\nEach mutation produces a **sync event** that is:\n1. Applied locally (optimistic)\n2. Queued in `sync_outbox` table\n3. Sent to server when online\n4. Acknowledged with server timestamp\n5. Conflicts resolved via LWW per field\n\n> The sync engine must handle **network partitions** gracefully. Tasks created offline should sync without data loss when connectivity is restored.\n\n## Performance Targets\n\n| Metric | Target |\n|--------|--------|\n| Task list render | < 16ms |\n| Task create (local) | < 5ms |\n| Sync round-trip | < 200ms |\n| Offline queue capacity | 10,000 events |\n\n## Open Questions\n\n- Should we support **real-time collaboration** (multiple users editing the same task)?\n- How do we handle **schema migrations** for the SQLite database?\n- What is the **retention policy** for events?',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms10',
    headingId: 'h6',
    title: 'Mixed: Accessibility audit',
    notes: 'Ensure the task list meets **WCAG 2.1 AA** standards.\n\n### Checklist\n- [ ] All interactive elements have `aria-label` or visible label\n- [ ] Drag-and-drop has keyboard alternative\n- [ ] Focus management after task creation/deletion\n- [ ] Color contrast ratios ≥ 4.5:1 for text\n- [ ] Screen reader announces state changes\n- [ ] `role="listbox"` on task list, `role="option"` on items\n\n### Keyboard Shortcuts\n| Key | Action |\n|-----|--------|\n| `↑` / `↓` | Move selection |\n| `Enter` | Open detail |\n| `Escape` | Close detail |\n| `Space` | Toggle state |\n| `Cmd+N` | New task |\n| `Delete` | Cancel task |\n\n> Run [axe-core](https://www.deque.com/axe/) scan before each release.',
    state: 'todo',
    due: '',
  },
  {
    id: 'ms11',
    headingId: 'h6',
    title: 'Mixed: Code + Diagram + Math combined',
    notes: '## Sync Conflict Resolution\n\nWhen two clients edit the same field, we use **last-write-wins** with Lamport timestamps.\n\n### Algorithm\n\n```typescript\nfunction resolve<T>(local: Versioned<T>, remote: Versioned<T>): T {\n  if (remote.timestamp > local.timestamp) return remote.value\n  if (remote.timestamp < local.timestamp) return local.value\n  // Tie-break by client ID (lexicographic)\n  return remote.clientId > local.clientId\n    ? remote.value\n    : local.value\n}\n```\n\n### Convergence proof\n\nFor $$n$$ clients with unique IDs, the resolution function is:\n- **Commutative**: $$f(a, b) = f(b, a)$$ for equal timestamps\n- **Idempotent**: $$f(a, a) = a$$\n- **Associative**: $$f(f(a, b), c) = f(a, f(b, c))$$\n\nThis guarantees all replicas converge to the same state.\n\n### Flow\n\n```mermaid\ngraph TD\n    A[Local Write] --> B{Conflict?}\n    B -->|No| C[Apply directly]\n    B -->|Yes| D[Compare timestamps]\n    D --> E{Remote wins?}\n    E -->|Yes| F[Apply remote]\n    E -->|No| G[Keep local]\n    F --> H[Emit reconciled event]\n    G --> H\n```\n\n> This approach trades *correctness under concurrent edits* for **simplicity**. A future version could use operation-based CRDTs for richer merge semantics.',
    state: 'in_progress',
    due: '',
  },
  {
    id: 'ms12',
    headingId: 'h6',
    title: 'Prose: Rich formatting showcase',
    notes: 'This task demonstrates all **basic** formatting.\n\n## Headings work\n\n### And sub-headings too\n\nHere is some *italic text*, some **bold text**, and some ***bold italic***. We also have `inline code` and ~~strikethrough~~.\n\n## Lists\n\nUnordered:\n- First item\n- Second item with **bold** inside\n  - Nested item\n  - Another nested one\n- Third item\n\nOrdered:\n1. Step one\n2. Step two\n3. Step three\n\n## Blockquotes\n\n> This is a quote.\n> It can span multiple lines.\n>\n> And even have **formatting** inside.\n\n## Links, images, and code\n\nVisit [Craft](https://craft.do) for more info.\n\n![Rich formatting sample image](https://picsum.photos/seed/planner-rich-formatting/1100/520 "Rich formatting sample")\n\n```bash\n# A simple shell script\nfor i in $(seq 1 5); do\n  echo \"Task $i completed\"\ndone\n```\n\n---\n\nThat horizontal rule above separates sections nicely.',
    state: 'done',
    due: '',
  },
]

export const snapshots: SessionSnapshot[] = [
  {
    id: 's1',
    title: 'Planner architecture review',
    summary: 'Validated portable core + local integration split; queued DB schema migration checklist.',
    lastUpdated: '5 min ago',
  },
  {
    id: 's2',
    title: 'Drag interaction tuning',
    summary: 'Following the same dnd-kit/dom path as the vertical sample for consistency.',
    lastUpdated: '1 hour ago',
  },
]

export const sessionLinks: TaskSessionLinkLocal[] = [
  { id: 'l1', taskId: 't1', snapshotId: 's1', syncState: 'uploaded' },
  { id: 'l2', taskId: 't1', snapshotId: 's2', syncState: 'pending_upload' },
  { id: 'l3', taskId: 't2', snapshotId: 's1', syncState: 'unavailable' },
]

export const events: PlannerTaskEvent[] = [
  { id: 'e1', taskId: 't1', type: 'task.created', at: 'Today · 18:12', actor: 'Balint', payloadSummary: 'Task created in Today heading' },
  { id: 'e2', taskId: 't1', type: 'task.session_linked', at: 'Today · 18:20', actor: 'Balint', payloadSummary: 'Linked session snapshot s1' },
  { id: 'e3', taskId: 't1', type: 'task.updated', at: 'Today · 18:27', actor: 'Balint', payloadSummary: 'Updated notes and due date' },
  { id: 'e4', taskId: 't1', type: 'task.session_snapshot_updated', at: 'Today · 18:42', actor: 'Craft Agent', payloadSummary: 'Refreshed snapshot summary' },
]

export const stateStyles: Record<TaskState, string> = {
  todo: 'text-foreground/45',
  in_progress: 'text-info',
  done: 'text-success',
  cancelled: 'text-destructive/70',
}

export const stateLabels: Record<TaskState, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const syncMeta: Record<SyncState, { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  local_only: { label: 'Local only', icon: CloudOff, cls: 'text-foreground/55 bg-foreground/7' },
  pending_upload: { label: 'Pending upload', icon: CloudUpload, cls: 'text-info bg-info/12' },
  uploaded: { label: 'Uploaded', icon: CloudCheck, cls: 'text-success bg-success/12' },
  remote_only: { label: 'Remote only', icon: CloudCheck, cls: 'text-accent bg-accent/12' },
  unavailable: { label: 'Unavailable', icon: CloudAlert, cls: 'text-warning bg-warning/12' },
  upload_failed: { label: 'Upload failed', icon: CloudAlert, cls: 'text-destructive bg-destructive/12' },
}
