/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import "lucide-react";
import type { ComponentEntry } from "./types";
import "@/lib/utils";
import "@config/models";
import "@/components/app-shell/kanban/KanbanBoard";
import "@/components/app-shell/kanban/TaskTile";
import "@/components/app-shell/kanban/TaskChatPreview";
import "@/components/app-shell/kanban/StatusBadge";
import "@/components/app-shell/kanban/ModelChip";
import "@/components/app-shell/kanban/status-column";
import "../demos/kanban/mock-kanban-data";
import { TREATMENT_OPTIONS, STATUS_OPTIONS, MODEL_OPTIONS } from "./kanban/fixtures";
import { KanbanViewPreview, TaskTilePreview, KanbanTaskWindowPreview } from "./kanban/previews";
import "./kanban/windows";

// ============================================================================
// Registry
// ============================================================================

export const kanbanComponents: ComponentEntry[] = [
  {
    id: 'kanban-board',
    name: 'Kanban Board',
    category: 'Kanban',
    description:
      'The 3-column board (ToDo / In Progress / Done) with the List⇄Board toggle in the All-Tasks header. Tiles place by column, independent from their status badge. Clicking a tile — or any spawned subtask row — opens that session in a (simulated) separate window; the "+ Add subtask" composer creates a pending subtask, and the Play (▶) button on a tile dispatches all pending subtasks to the orchestrator.',
    component: KanbanViewPreview,
    layout: 'full',
    props: [
      {
        name: 'view',
        description: 'Which view the All-Sessions header toggle starts on',
        control: { type: 'select', options: [{ label: 'Board', value: 'board' }, { label: 'List', value: 'list' }] },
        defaultValue: 'board',
      },
      {
        name: 'treatment',
        description: 'How a tile shows its project color',
        control: { type: 'select', options: TREATMENT_OPTIONS },
        defaultValue: 'stripe-tint',
      },
    ],
    variants: [
      { name: 'Board view', description: 'Default 3-column board', props: { view: 'board', treatment: 'stripe-tint' } },
      { name: 'Board · stripe only', description: 'Project color as a stripe without tint', props: { view: 'board', treatment: 'stripe' } },
      { name: 'List view (stub)', description: 'Toggle flipped to the (stubbed) list', props: { view: 'list' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'kanban-task-tile',
    name: 'Task Tile (anatomy)',
    category: 'Kanban',
    description:
      'A single parent-session tile: project color, status badge (independent from column), orchestrator model, a collapsable auto-routed subtask list, an inline "+ Add subtask" composer (type a title → Add → creates a pending subtask), and a Play (▶) button that dispatches all pending subtasks.',
    component: TaskTilePreview,
    layout: 'centered',
    props: [
      {
        name: 'subtasksExpanded',
        description: 'Expand the spawned-subtask list',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'statusId',
        description: 'Status badge — independent from the board column',
        control: { type: 'select', options: STATUS_OPTIONS },
        defaultValue: 'in-progress',
      },
      {
        name: 'treatment',
        description: 'Project color treatment',
        control: { type: 'select', options: TREATMENT_OPTIONS },
        defaultValue: 'stripe-tint',
      },
      {
        name: 'model',
        description: 'Orchestrator model for the parent task',
        control: { type: 'select', options: MODEL_OPTIONS },
        defaultValue: 'claude-opus-4-7',
      },
    ],
    variants: [
      { name: 'Expanded', description: 'Subtasks visible', props: { subtasksExpanded: true } },
      { name: 'Collapsed', description: 'Subtasks hidden', props: { subtasksExpanded: false } },
      { name: 'Needs Review', description: 'Needs-review badge (would sit in In Progress)', props: { statusId: 'needs-review' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'kanban-task-window',
    name: 'Task Window (chat-only)',
    category: 'Kanban',
    description:
      'The focused task window body: title bar, transcript showing Task mode acting as an orchestrator that spawns best-fit-model subtasks, and an input bar. No board, no sidebar.',
    component: KanbanTaskWindowPreview,
    layout: 'full',
    props: [],
    mockData: () => ({}),
  },
]
