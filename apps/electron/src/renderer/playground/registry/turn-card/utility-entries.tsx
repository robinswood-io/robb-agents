import type { ComponentEntry } from "../types";
import { sampleGenericContent } from "./document-fixtures";
import { MultiDiffPreviewOverlayPlayground, TerminalPreviewOverlayPlayground, JSONPreviewOverlayPlayground, GenericOverlayPlayground, DataTableOverlayPlayground } from "./overlays";
import { sampleMultiDiffChanges, sampleSingleChange } from "./code-fixtures";
import { sampleBashOutput, sampleBashErrorOutput, sampleGrepOutput, sampleGlobOutput, sampleJsonData, sampleNestedJsonData } from "./utility-fixtures";

export const multiDiffOverlayEntry: ComponentEntry = {
    id: 'multi-diff-overlay',
    name: 'MultiDiffPreviewOverlay',
    category: 'Fullscreen',
    description: 'Multi-file diff preview with sidebar navigation (Edit/Write tools)',
    component: MultiDiffPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'consolidated',
        description: 'Group changes by file path',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Multiple Files (Ungrouped)',
        description: 'Several file changes shown individually',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
        },
      },
      {
        name: 'Multiple Files (Consolidated)',
        description: 'Changes grouped by file path',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: true,
        },
      },
      {
        name: 'Single Edit',
        description: 'Single file change (no sidebar)',
        props: {
          changes: sampleSingleChange,
          consolidated: false,
        },
      },
      {
        name: 'Focused Change',
        description: 'Opens with a specific change focused',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
          focusedChangeId: 'change-3',
        },
      },
      {
        name: 'New File (Write)',
        description: 'A newly written file (no original)',
        props: {
          changes: [sampleMultiDiffChanges[2]], // The rate-limiter Write
          consolidated: false,
        },
      },
    ],
    mockData: () => ({
      changes: sampleMultiDiffChanges,
    }),
  };

export const terminalPreviewOverlayEntry: ComponentEntry = {
    id: 'terminal-preview-overlay',
    name: 'TerminalPreviewOverlay',
    category: 'Fullscreen',
    description: 'Terminal output preview (Bash/Grep/Glob tools)',
    component: TerminalPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'toolType',
        description: 'Tool type for display styling',
        control: {
          type: 'select',
          options: [
            { label: 'Bash', value: 'bash' },
            { label: 'Grep', value: 'grep' },
            { label: 'Glob', value: 'glob' },
          ],
        },
        defaultValue: 'bash',
      },
    ],
    variants: [
      {
        name: 'Bash: Test Suite',
        description: 'npm test output with passing tests',
        props: {
          command: 'npm test',
          output: sampleBashOutput,
          exitCode: 0,
          toolType: 'bash',
          description: 'Running the test suite',
        },
      },
      {
        name: 'Bash: Error',
        description: 'Failed deployment command',
        props: {
          command: 'npm run deploy',
          output: sampleBashErrorOutput,
          exitCode: 1,
          toolType: 'bash',
          description: 'Deploy to production',
        },
      },
      {
        name: 'Grep: Search Results',
        description: 'Searching for class/function definitions',
        props: {
          command: 'grep "export class" src/auth/',
          output: sampleGrepOutput,
          exitCode: 0,
          toolType: 'grep',
          description: 'Search for "export class" in src/auth/',
        },
      },
      {
        name: 'Glob: File Listing',
        description: 'Finding files matching a pattern',
        props: {
          command: 'glob "src/auth/**/*.ts"',
          output: sampleGlobOutput,
          exitCode: 0,
          toolType: 'glob',
          description: 'Find files matching "src/auth/**/*.ts"',
        },
      },
      {
        name: 'Command Failed (Error Banner)',
        description: 'Command blocked by permission system',
        props: {
          command: 'rm -rf /tmp/build-cache',
          output: '',
          exitCode: 1,
          toolType: 'bash',
          description: 'Clean build cache',
          error: "Bash command `rm -rf /tmp/build-cache` is not in the read-only allowlist.\n\nMatched: `rm` (2 chars)\nFailed at: ` ` (position 2)\n\nPattern: Remove files\n\nSwitch to Ask or Allow All mode (SHIFT+TAB) to run it.",
        },
      },
    ],
    mockData: () => ({
      command: 'npm test',
      output: sampleBashOutput,
      exitCode: 0,
      toolType: 'bash',
      description: 'Running tests',
    }),
  };

export const jsonPreviewOverlayEntry: ComponentEntry = {
    id: 'json-preview-overlay',
    name: 'JSONPreviewOverlay',
    category: 'Fullscreen',
    description: 'Interactive JSON tree viewer with expand/collapse',
    component: JSONPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Title shown in header',
        control: { type: 'string', placeholder: 'e.g., API Response' },
        defaultValue: 'JSON Result',
      },
    ],
    variants: [
      {
        name: 'Complex Object',
        description: 'Deeply nested user/org data',
        props: {
          data: sampleJsonData,
          title: 'User Profile',
        },
      },
      {
        name: 'API Response',
        description: 'Typical paginated API response',
        props: {
          data: sampleNestedJsonData,
          title: 'Search Results',
        },
      },
      {
        name: 'Simple Array',
        description: 'Array of simple objects',
        props: {
          data: [
            { id: 1, name: 'Alpha', status: 'active' },
            { id: 2, name: 'Beta', status: 'pending' },
            { id: 3, name: 'Gamma', status: 'inactive' },
          ],
          title: 'Items List',
        },
      },
      {
        name: 'Minimal',
        description: 'Small JSON payload',
        props: {
          data: { success: true, message: 'Operation completed', count: 42 },
          title: 'Status',
        },
      },
      {
        name: 'Parse Error',
        description: 'Error state when JSON parsing fails',
        props: {
          data: {},
          title: 'API Response',
          error: "Unexpected token '<' at position 0. The server returned HTML instead of JSON.\n\nResponse starts with: <!DOCTYPE html><html><head><title>502 Bad Gateway</title>...",
        },
      },
    ],
    mockData: () => ({
      data: sampleJsonData,
      title: 'JSON Result',
    }),
  };

export const genericOverlayEntry: ComponentEntry = {
    id: 'generic-overlay',
    name: 'GenericOverlay',
    category: 'Fullscreen',
    description: 'Fallback overlay for unknown tool content with auto-language detection',
    component: GenericOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Header title',
        control: { type: 'string', placeholder: 'e.g., WebFetch Result' },
        defaultValue: 'Activity',
      },
    ],
    variants: [
      {
        name: 'Markdown Content',
        description: 'Web-fetched documentation',
        props: {
          content: sampleGenericContent,
          title: 'WebFetch Result',
        },
      },
      {
        name: 'Plain Text',
        description: 'Simple text output',
        props: {
          content: 'Build completed successfully.\n\nOutput:\n  dist/index.js (245 KB)\n  dist/index.css (12 KB)\n  dist/assets/ (3 files)\n\nTotal size: 257 KB (gzipped: 62 KB)',
          title: 'Build Output',
        },
      },
      {
        name: 'JSON-like Content',
        description: 'Content that looks like JSON',
        props: {
          content: JSON.stringify({ status: 'ok', version: '2.1.0', uptime: '14d 3h 22m' }, null, 2),
          title: 'Health Check',
        },
      },
    ],
    mockData: () => ({
      content: sampleGenericContent,
      title: 'Activity',
    }),
  };

export const dataTableOverlayEntry: ComponentEntry = {
    id: 'data-table-overlay',
    name: 'DataTableOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen data table view with scrollable content',
    component: DataTableOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Table title in header',
        control: { type: 'string', placeholder: 'e.g., Permissions' },
        defaultValue: 'Permissions',
      },
      {
        name: 'subtitle',
        description: 'Optional subtitle (e.g., row count)',
        control: { type: 'string', placeholder: 'e.g., 8 tools' },
        defaultValue: '8 tools',
      },
    ],
    variants: [
      {
        name: 'Tool Permissions',
        description: 'Table showing tool permission levels',
        props: {
          title: 'Tool Permissions',
          subtitle: '8 tools configured',
        },
      },
      {
        name: 'No Subtitle',
        description: 'Table without subtitle',
        props: {
          title: 'Configuration',
        },
      },
    ],
    mockData: () => ({
      title: 'Permissions',
      subtitle: '8 tools',
    }),
  };
