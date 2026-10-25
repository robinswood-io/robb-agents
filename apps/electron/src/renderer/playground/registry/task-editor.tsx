/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import "lucide-react";
import "sonner";
import "@/lib/utils";
import "@config/models";
import "@/components/ui/dropdown-menu";
import "@/components/ui/popover";
import "@/components/ui/session-status-menu";
import "../demos/kanban/mock-kanban-data";
import type { ComponentEntry } from "./types";
import "./task-editor/fixtures";
import "./task-editor/controls";
import { TaskEditorPreview } from "./task-editor/preview";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const taskEditorComponents: ComponentEntry[] = [
  {
    id: 'task-editor',
    name: 'Task Editor',
    category: 'Kanban',
    description:
      "Full-pane editor opened from 'Add Task'. Two modes for how subtasks come to exist: Generate — write a goal and let the orchestrator draft the subtasks (model routing + dependencies) when the task runs; Manual — author them by hand. The subtask editor only appears in Manual mode. Nothing runs here — Prepare writes a task.yaml under Workspace/tasks/ and creates the orchestrator session (plus the pending subtask sessions in Manual mode), which you then dispatch from the board. The YAML preview is live. (Buttons toast; this is a UI mock — no real files/sessions.)",
    component: TaskEditorPreview,
    layout: 'full',
    props: [
      {
        name: 'mode',
        description: 'Starting mode',
        control: { type: 'select', options: [{ label: 'Generate', value: 'generate' }, { label: 'Manual', value: 'manual' }] },
        defaultValue: 'generate',
      },
    ],
    variants: [
      { name: 'Generate', description: 'AI drafts the subtasks from the goal at run time — no manual list', props: { mode: 'generate' } },
      { name: 'Manual', description: 'Author the subtasks by hand', props: { mode: 'manual' } },
    ],
    mockData: () => ({}),
  },
]
