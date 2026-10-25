/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import "lucide-react";
import "@/components/app-shell/SessionSearchHeader";
import "@/components/app-shell/SessionItem";
import "@/context/SessionListContext";
import "@/actions/registry";
import { sampleSessions } from "./session-list/fixtures";
import { SessionListSearchPreview, SessionItemPreview } from "./session-list/previews";

// ============================================================================
// Registry Entries
// ============================================================================

export const sessionListComponents: ComponentEntry[] = [
  {
    id: 'session-list-search',
    name: 'SessionList Search States',
    category: 'Session List',
    description: 'Session list using real SessionItem components with search and badges',
    component: SessionListSearchPreview,
    props: [
      {
        name: 'searchQuery',
        description: 'Current search query text',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'showSearchInput',
        description: 'Show the search input bar',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'isSearching',
        description: 'Show loading spinner while searching',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'selectedIndex',
        description: 'Index of selected session (0-based)',
        control: { type: 'number', min: 0, max: 3, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches in chat (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'showNoResults',
        description: 'Show empty/no results state',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'resultCount',
        description: 'Explicit result count to display',
        control: { type: 'number', min: 0, max: 999, step: 1 },
        defaultValue: undefined,
      },
    ],
    variants: [
      {
        name: 'Default (No Search)',
        description: 'Normal session list without search active',
        props: {
          searchQuery: '',
          showSearchInput: false,
        },
      },
      {
        name: 'Search Active',
        description: 'Search input visible, no query yet',
        props: {
          searchQuery: '',
          showSearchInput: true,
        },
      },
      {
        name: 'Title Match Highlight',
        description: 'Search query matching session titles',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          resultCount: 2,
        },
      },
      {
        name: 'With Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          chatMatchCount: 5,
          resultCount: 47,
        },
      },
      {
        name: 'Searching (Loading)',
        description: 'Content search in progress',
        props: {
          searchQuery: 'complex query',
          showSearchInput: true,
          isSearching: true,
        },
      },
      {
        name: 'No Results',
        description: 'Search returned no matches',
        props: {
          searchQuery: 'xyznonexistent',
          showSearchInput: true,
          showNoResults: true,
          resultCount: 0,
        },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-item-search',
    name: 'SessionItem States',
    category: 'Session List',
    description: 'Individual real SessionItem showing visual states with search and badges',
    component: SessionItemPreview,
    props: [
      {
        name: 'state',
        description: 'Indicator state shown next to status icon',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Loading', value: 'loading' },
            { label: 'Plan', value: 'plan' },
            { label: 'New', value: 'new' },
          ],
        },
        defaultValue: 'none',
      },
      {
        name: 'searchQuery',
        description: 'Search query for highlighting',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'isSelected',
        description: 'Whether this session is selected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'flagged',
        description: 'Whether the session is flagged',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'subagentCount',
        description: 'Total hidden sub-agents linked to this parent session',
        control: { type: 'number', min: 0, max: 99, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'runningSubagentCount',
        description: 'Hidden sub-agents currently running',
        control: { type: 'number', min: 0, max: 99, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      {
        name: 'Default',
        description: 'Normal state without indicators',
        props: {
          item: sampleSessions[0],
          state: 'none',
        },
      },
      {
        name: 'Loading',
        description: 'Session is processing (shows spinner)',
        props: {
          item: sampleSessions[0],
          state: 'loading',
        },
      },
      {
        name: 'Plan Pending',
        description: 'Session has a pending plan (shows compass icon)',
        props: {
          item: sampleSessions[0],
          state: 'plan',
        },
      },
      {
        name: 'New / Unread',
        description: 'Session has unread messages (shows accent dot)',
        props: {
          item: sampleSessions[0],
          state: 'new',
        },
      },
      {
        name: 'Flagged',
        description: 'Session is flagged',
        props: {
          item: sampleSessions[0],
          flagged: true,
        },
      },
      {
        name: 'Title Highlighted',
        description: 'Search query highlights in title',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
        },
      },
      {
        name: 'Selected with Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
          isSelected: true,
          chatMatchCount: 5,
        },
      },
      {
        name: 'Hidden Sub-agents Running',
        description: 'Parent-only navigation with a count and running indicator',
        props: {
          item: sampleSessions[0],
          subagentCount: 4,
          runningSubagentCount: 2,
        },
      },
    ],
    mockData: () => ({
      item: sampleSessions[0],
    }),
  },
]
