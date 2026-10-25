/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import "@dnd-kit/dom";
import "@dnd-kit/dom/sortable";
import "lucide-react";
import "@/components/ui/button";
import "@/components/ui/input";
import "@/components/ui/metadata-badge";
import "@/components/ui/scroll-area";
import "@/components/ui/styled-dropdown";
import "@craft-agent/ui";
import "@/lib/utils";
import "@/hooks/useResizeGradient";
import "@/components/app-shell/panel-constants";
import "./planner.css";
import "./planner/models";
import "./planner/fixtures";
import { PlannerSyncStatePalette } from "./planner/ordering";
import { PlannerBoard } from "./planner/board";
import "./planner/view";

export const plannerComponents: ComponentEntry[] = [
  {
    id: 'planner-things-board',
    name: 'Planner Board',
    category: 'Planner',
    description: 'Planner surface with @dnd-kit/dom sortable behavior matching the vertical sample path.',
    component: PlannerBoard,
    layout: 'full',
    props: [],
  },
  {
    id: 'planner-sync-palette',
    name: 'Planner Sync Palette',
    category: 'Planner',
    description: 'Visual language for task_session_links_local sync states.',
    component: PlannerSyncStatePalette,
    props: [],
  },
]
