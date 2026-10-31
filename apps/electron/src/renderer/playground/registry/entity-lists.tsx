/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import "react";
import "lucide-react";
import "@craft-agent/ui";
import "@/lib/utils";
import "@/components/ui/entity-row";
import "@/components/ui/entity-list";
import "@/components/ui/empty";
import "@/components/ui/menu-context";
import "@/hooks/useEntityListInteractions";
import type { ComponentEntry } from "./types";
import { EntityRowPreview } from "./entity-lists/primitives";
import "./entity-lists/fixtures";
import { SessionEntityListPreview, SourceEntityListPreview, SkillEntityListPreview } from "./entity-lists/lists";
import { MixedEntityListPreview } from "./entity-lists/mixed";
import { InteractiveEntityListPreview } from "./entity-lists/interactive";

// ============================================================================
// Registry Entries
// ============================================================================

export const entityListComponents: ComponentEntry[] = [
  // ---- EntityRow primitive ----
  {
    id: 'entity-row',
    name: 'EntityRow',
    category: 'Entity Lists',
    description: 'Base row primitive with icon, title, badges, trailing, and menu slots',
    component: EntityRowPreview,
    layout: 'centered',
    props: [
      { name: 'title', description: 'Title text', control: { type: 'string', placeholder: 'Entity name...' }, defaultValue: 'Sample Entity' },
      { name: 'subtitle', description: 'Subtitle/description text', control: { type: 'string', placeholder: 'Description...' }, defaultValue: 'A short description' },
      { name: 'showIcon', description: 'Show left icon', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showBadges', description: 'Show badge row (overrides subtitle)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showTrailing', description: 'Show trailing timestamp', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showMenu', description: 'Show more menu on hover', control: { type: 'boolean' }, defaultValue: true },
      { name: 'isSelected', description: 'Selected state', control: { type: 'boolean' }, defaultValue: false },
      { name: 'isInMultiSelect', description: 'Multi-select state (accent bar)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showSeparator', description: 'Show separator above', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Minimal',
        description: 'Title only — no icon, badges, or menu',
        props: { showIcon: false, showBadges: false, showMenu: false },
      },
      {
        name: 'Source-like',
        description: 'Icon + type badge + description',
        props: { showIcon: true, showBadges: true, showTrailing: false, showMenu: true },
      },
      {
        name: 'Session-like',
        description: 'Icon + badges + trailing timestamp',
        props: { showIcon: true, showBadges: true, showTrailing: true, showMenu: true },
      },
      {
        name: 'Selected',
        description: 'Selected state with tinted background',
        props: { isSelected: true },
      },
      {
        name: 'Multi-select',
        description: 'Multi-select state with left accent bar',
        props: { isInMultiSelect: true },
      },
    ],
  },

  // ---- Session List (via EntityRow) ----
  {
    id: 'entity-list-sessions',
    name: 'Session List',
    category: 'Entity Lists',
    description: 'Session items composed with EntityRow — status icon, badges, timestamps',
    component: SessionEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected session index', control: { type: 'number', min: -1, max: 3, step: 1 }, defaultValue: 0 },
      { name: 'showMultiSelect', description: 'Show multi-select on first two items', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Default',
        description: 'First session selected',
        props: { selectedIndex: 0 },
      },
      {
        name: 'Multi-select',
        description: 'Two sessions in multi-select',
        props: { selectedIndex: 0, showMultiSelect: true },
      },
      {
        name: 'No Selection',
        description: 'No session selected',
        props: { selectedIndex: -1 },
      },
    ],
  },

  // ---- Source List (via EntityRow) ----
  {
    id: 'entity-list-sources',
    name: 'Source List',
    category: 'Entity Lists',
    description: 'Source items composed with EntityRow — type badge, status badge, tagline',
    component: SourceEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected source index (-1 for none)', control: { type: 'number', min: -1, max: 4, step: 1 }, defaultValue: -1 },
      {
        name: 'typeFilter',
        description: 'Filter by source type',
        control: {
          type: 'select',
          options: [
            { label: 'All', value: 'all' },
            { label: 'MCP', value: 'mcp' },
            { label: 'API', value: 'api' },
            { label: 'Local', value: 'local' },
          ],
        },
        defaultValue: 'all',
      },
    ],
    variants: [
      {
        name: 'All Sources',
        description: 'All source types shown',
        props: { typeFilter: 'all' },
      },
      {
        name: 'MCP Only',
        description: 'Filtered to MCP sources',
        props: { typeFilter: 'mcp' },
      },
      {
        name: 'With Selection',
        description: 'First source selected',
        props: { selectedIndex: 0 },
      },
    ],
  },

  // ---- Skill List (via EntityRow) ----
  {
    id: 'entity-list-skills',
    name: 'Skill List',
    category: 'Entity Lists',
    description: 'Skill items composed with EntityRow — emoji icon, description',
    component: SkillEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'selectedIndex', description: 'Selected skill index (-1 for none)', control: { type: 'number', min: -1, max: 3, step: 1 }, defaultValue: -1 },
    ],
    variants: [
      {
        name: 'Default',
        description: 'No selection',
        props: { selectedIndex: -1 },
      },
      {
        name: 'With Selection',
        description: 'First skill selected',
        props: { selectedIndex: 0 },
      },
    ],
  },

  // ---- Mixed Entity List (all three grouped) ----
  {
    id: 'entity-list-mixed',
    name: 'Mixed Entity List',
    category: 'Entity Lists',
    description: 'All entity types in one list, demonstrating grouped sections',
    component: MixedEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'showGroups', description: 'Group by entity type', control: { type: 'boolean' }, defaultValue: true },
      { name: 'selectedIndex', description: 'Selected item index (flat, -1 for none)', control: { type: 'number', min: -1, max: 5, step: 1 }, defaultValue: -1 },
      { name: 'showEmpty', description: 'Show empty state', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'Grouped',
        description: 'Items grouped by Sessions, Sources, Skills',
        props: { showGroups: true },
      },
      {
        name: 'Flat List',
        description: 'All items in a single flat list',
        props: { showGroups: false },
      },
      {
        name: 'Empty State',
        description: 'No items — shows empty placeholder',
        props: { showEmpty: true },
      },
      {
        name: 'With Selection',
        description: 'Third item selected in grouped view',
        props: { showGroups: true, selectedIndex: 2 },
      },
    ],
  },

  // ---- Interactive Entity List (keyboard + multi-select + search) ----
  {
    id: 'entity-list-interactive',
    name: 'Interactive Entity List',
    category: 'Entity Lists',
    description: 'Full interactive demo — keyboard nav, multi-select, search filtering via useEntityListInteractions',
    component: InteractiveEntityListPreview,
    layout: 'centered',
    props: [
      { name: 'enableSearch', description: 'Enable search filtering', control: { type: 'boolean' }, defaultValue: true },
      { name: 'enableMultiSelect', description: 'Enable Cmd+Click / Shift+Click multi-select', control: { type: 'boolean' }, defaultValue: true },
      { name: 'enableKeyboard', description: 'Enable arrow key navigation', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      {
        name: 'Full Interactive',
        description: 'All interactions enabled — search, keyboard, multi-select',
        props: { enableSearch: true, enableMultiSelect: true, enableKeyboard: true },
      },
      {
        name: 'Search Only',
        description: 'Just search filtering, no keyboard or multi-select',
        props: { enableSearch: true, enableMultiSelect: false, enableKeyboard: false },
      },
      {
        name: 'Keyboard Only',
        description: 'Arrow keys + Enter, no search or multi-select',
        props: { enableSearch: false, enableMultiSelect: false, enableKeyboard: true },
      },
      {
        name: 'Multi-select Only',
        description: 'Click-based multi-select, no search or keyboard',
        props: { enableSearch: false, enableMultiSelect: true, enableKeyboard: false },
      },
    ],
  },
]
