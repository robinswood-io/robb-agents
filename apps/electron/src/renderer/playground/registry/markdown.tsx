/** Playground entries; scenario data and preview components are kept in adjacent sections. */
import "react";
import type { ComponentEntry } from "./types";
import { LocalPdfPreviewDemo } from "../demos/LocalPdfPreviewDemo";
import { Markdown, CodeBlock, InlineCode, MarkdownDatatableBlock, MarkdownSpreadsheetBlock, MarkdownImageBlock } from "@craft-agent/ui";
import { sampleMarkdown, codeHeavyMarkdown, typescriptCode, pythonCode, jsonCode, MOCK_IMAGE_DATA, richBlockParityMarkdown } from "./markdown/fixtures";
import { CollapsibleWrapper, ImageCardStackPlayground, MarkdownImageBlockWrapper } from "./markdown/previews";

export const markdownComponents: ComponentEntry[] = [
  {
    id: 'local-pdf-preview', name: 'Local PDF Preview', category: 'Markdown',
    description: 'Local document links, sandbox/file references, spaces, Unicode and useful missing-file errors.',
    component: LocalPdfPreviewDemo, layout: 'top', props: [], variants: [],
  },
  {
    id: 'markdown',
    name: 'Markdown',
    category: 'Markdown',
    description: 'Customizable markdown renderer with three render modes: terminal, minimal, full',
    component: Markdown,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown content to render',
        control: { type: 'textarea', rows: 10 },
        defaultValue: sampleMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'minimal',
      },
      {
        name: 'collapsible',
        description: 'Enable collapsible headings',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Terminal', props: { children: sampleMarkdown, mode: 'terminal' } },
      { name: 'Minimal', props: { children: sampleMarkdown, mode: 'minimal' } },
      { name: 'Full', props: { children: sampleMarkdown, mode: 'full' } },
      { name: 'Code Heavy', props: { children: codeHeavyMarkdown, mode: 'minimal' } },
      { name: 'Collapsible', props: { children: sampleMarkdown, mode: 'full', collapsible: true } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
    wrapper: CollapsibleWrapper,
  },
  {
    id: 'code-block',
    name: 'CodeBlock',
    category: 'Markdown',
    description: 'Syntax highlighted code block using Shiki with copy button',
    component: CodeBlock,
    props: [
      {
        name: 'code',
        description: 'Code to display',
        control: { type: 'textarea', rows: 8 },
        defaultValue: typescriptCode,
      },
      {
        name: 'language',
        description: 'Programming language for syntax highlighting',
        control: {
          type: 'select',
          options: [
            { label: 'TypeScript', value: 'typescript' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Python', value: 'python' },
            { label: 'JSON', value: 'json' },
            { label: 'Bash', value: 'bash' },
            { label: 'Plain Text', value: 'text' },
          ],
        },
        defaultValue: 'typescript',
      },
      {
        name: 'mode',
        description: 'Render mode',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'TypeScript Full', props: { code: typescriptCode, language: 'typescript', mode: 'full' } },
      { name: 'TypeScript Minimal', props: { code: typescriptCode, language: 'typescript', mode: 'minimal' } },
      { name: 'Python', props: { code: pythonCode, language: 'python', mode: 'full' } },
      { name: 'JSON', props: { code: jsonCode, language: 'json', mode: 'full' } },
    ],
  },
  {
    id: 'inline-code',
    name: 'InlineCode',
    category: 'Markdown',
    description: 'Styled inline code span with subtle background and border',
    component: InlineCode,
    props: [
      {
        name: 'children',
        description: 'Code text',
        control: { type: 'string' },
        defaultValue: 'const x = 42',
      },
    ],
    variants: [
      { name: 'Variable', props: { children: 'useState' } },
      { name: 'Function', props: { children: 'handleClick()' } },
      { name: 'Type', props: { children: 'React.FC<Props>' } },
      { name: 'Path', props: { children: 'src/components/App.tsx' } },
    ],
  },
  {
    id: 'datatable-block',
    name: 'MarkdownDatatableBlock',
    category: 'Markdown',
    description: 'Interactive data table with sorting for ```datatable code blocks',
    component: MarkdownDatatableBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Sales by Region',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'revenue', label: 'Revenue', type: 'currency' },
            { key: 'growth', label: 'Growth', type: 'percent' },
            { key: 'units', label: 'Units Sold', type: 'number' },
            { key: 'status', label: 'Status', type: 'badge' },
          ],
          rows: [
            { region: 'North America', revenue: 1250000, growth: 0.124, units: 8420, status: 'Active' },
            { region: 'Europe', revenue: 980000, growth: 0.087, units: 6230, status: 'Active' },
            { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, units: 12100, status: 'Active' },
            { region: 'Latin America', revenue: 420000, growth: -0.032, units: 2800, status: 'Revoked' },
            { region: 'Middle East', revenue: 310000, growth: 0.156, units: 1900, status: 'Active' },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Sales Data',
        props: {
          code: JSON.stringify({
            title: 'Sales by Region',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'revenue', label: 'Revenue', type: 'currency' },
              { key: 'growth', label: 'Growth', type: 'percent' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { region: 'North America', revenue: 1250000, growth: 0.124, status: 'Active' },
              { region: 'Europe', revenue: 980000, growth: 0.087, status: 'Active' },
              { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, status: 'Active' },
              { region: 'Latin America', revenue: 420000, growth: -0.032, status: 'Revoked' },
            ],
          }),
        },
      },
      {
        name: 'Boolean & Badge Types',
        props: {
          code: JSON.stringify({
            title: 'API Keys',
            columns: [
              { key: 'name', label: 'Name', type: 'text' },
              { key: 'active', label: 'Active', type: 'boolean' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { name: 'Production', active: true, status: 'Passing' },
              { name: 'Staging', active: true, status: 'Passing' },
              { name: 'Legacy', active: false, status: 'Failed' },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'spreadsheet-block',
    name: 'MarkdownSpreadsheetBlock',
    category: 'Markdown',
    description: 'Excel-style grid with column letters and row numbers for ```spreadsheet code blocks',
    component: MarkdownSpreadsheetBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          filename: 'Q1_Revenue.xlsx',
          sheetName: 'Summary',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'q1', label: 'Q1', type: 'currency' },
            { key: 'q2', label: 'Q2', type: 'currency' },
            { key: 'change', label: 'Change', type: 'percent' },
            { key: 'total', label: 'Total', type: 'formula' },
          ],
          rows: [
            { region: 'North', q1: 500000, q2: 620000, change: 0.24, total: 1120000 },
            { region: 'South', q1: 340000, q2: 310000, change: -0.088, total: 650000 },
            { region: 'East', q1: 780000, q2: 850000, change: 0.09, total: 1630000 },
            { region: 'West', q1: 420000, q2: 480000, change: 0.143, total: 900000 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Revenue Sheet',
        props: {
          code: JSON.stringify({
            filename: 'Q1_Revenue.xlsx',
            sheetName: 'Summary',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'q1', label: 'Q1', type: 'currency' },
              { key: 'q2', label: 'Q2', type: 'currency' },
              { key: 'change', label: 'Change', type: 'percent' },
            ],
            rows: [
              { region: 'North', q1: 500000, q2: 620000, change: 0.24 },
              { region: 'South', q1: 340000, q2: 310000, change: -0.088 },
              { region: 'East', q1: 780000, q2: 850000, change: 0.09 },
            ],
          }),
        },
      },
      {
        name: 'Simple Sheet (No Filename)',
        props: {
          code: JSON.stringify({
            columns: [
              { key: 'item', label: 'Item', type: 'text' },
              { key: 'qty', label: 'Quantity', type: 'number' },
              { key: 'price', label: 'Price', type: 'currency' },
            ],
            rows: [
              { item: 'Widget A', qty: 100, price: 29 },
              { item: 'Widget B', qty: 250, price: 15 },
              { item: 'Widget C', qty: 50, price: 89 },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'image-card-stack',
    name: 'ImageCardStack',
    category: 'Markdown',
    description: 'Swipeable card stack used for image gallery previews.',
    component: ImageCardStackPlayground,
    layout: 'full',
    props: [
      {
        name: 'items',
        description: 'Gallery items with optional aspect ratio values (width/height).',
        control: { type: 'textarea', rows: 10 },
        defaultValue: JSON.stringify([
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
        ], null, 2),
      },
      {
        name: 'maxRotate',
        description: 'Maximum baseline random card rotation in degrees.',
        control: { type: 'number', min: 0, max: 16, step: 1 },
        defaultValue: 5,
      },
    ],
    variants: [
      {
        name: 'Mixed Ratios',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
          ], null, 2),
          maxRotate: 5,
        },
      },
      {
        name: 'Large Gallery',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Shot 1', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Shot 2', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Shot 3', ratio: 16 / 9 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-4.png'], label: 'Shot 4', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-5.png'], label: 'Shot 5', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 7,
        },
      },
      {
        name: 'Subtle Rotation',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'One', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Two', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Three', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 2,
        },
      },
    ],
  },
  {
    id: 'markdown-image-block',
    name: 'MarkdownImageBlock',
    category: 'Markdown',
    description: 'Renders ```image-preview blocks with card-stack galleries and fullscreen overlay support.',
    component: MarkdownImageBlock,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'code',
        description: 'JSON spec for image-preview block.',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Image Gallery',
          items: [
            { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
            { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
            { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Single Image',
        props: {
          code: JSON.stringify({
            title: 'Single Image',
            src: '/mock/images/gallery-1.png',
          }, null, 2),
        },
      },
      {
        name: 'Gallery Stack',
        props: {
          code: JSON.stringify({
            title: 'Gallery Stack',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
              { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
              { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
              { src: '/mock/images/gallery-4.png', label: 'City', ratio: 4 / 3 },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Unknown Path Error',
        props: {
          code: JSON.stringify({
            title: 'Missing Image',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Found' },
              { src: '/mock/images/does-not-exist.png', label: 'Missing' },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'rich-block-interaction-parity',
    name: 'RichBlockInteractionParity',
    category: 'Markdown',
    description: 'Single playground fixture to verify inline + fullscreen interaction parity across Mermaid and image-preview blocks.',
    component: Markdown,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown fixture for parity checks',
        control: { type: 'textarea', rows: 20 },
        defaultValue: richBlockParityMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'Parity Fixture', props: { children: richBlockParityMarkdown, mode: 'full' } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
  },
]
