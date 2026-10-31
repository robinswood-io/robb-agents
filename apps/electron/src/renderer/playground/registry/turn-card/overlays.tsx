import { useState } from "react";
import { DocumentFormattedMarkdownOverlay, CodePreviewOverlay, MultiDiffPreviewOverlay, TerminalPreviewOverlay, JSONPreviewOverlay, GenericOverlay, DataTableOverlay, type FileChange } from "@craft-agent/ui";

/** Wrapper that provides controlled open state for playground */
export function DocumentFormattedMarkdownOverlayPlayground({
  content,
  variant,
}: {
  content: string
  variant?: 'response' | 'plan' | undefined
}) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        Open Document Overlay
      </button>
      <DocumentFormattedMarkdownOverlay
        content={content}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        variant={variant}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      />
    </div>
  )
}

/** Embedded preview of CodePreviewOverlay */
export function CodePreviewOverlayPlayground({
  content,
  filePath,
  mode,
  startLine,
  totalLines,
  numLines,
  error,
}: {
  content: string
  filePath: string
  mode?: 'read' | 'write' | undefined
  startLine?: number | undefined
  totalLines?: number | undefined
  numLines?: number | undefined
  error?: string | undefined
}) {
  return (
    <div className="h-[500px]">
      <CodePreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        filePath={filePath}
        mode={mode}
        startLine={startLine}
        totalLines={totalLines}
        numLines={numLines}
        error={error}
      />
    </div>
  )
}

/** Embedded preview of MultiDiffPreviewOverlay */
export function MultiDiffPreviewOverlayPlayground({
  changes,
  consolidated,
  focusedChangeId,
}: {
  changes: FileChange[]
  consolidated?: boolean | undefined
  focusedChangeId?: string | undefined
}) {
  return (
    <div className="h-[500px]">
      <MultiDiffPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        changes={changes}
        consolidated={consolidated}
        focusedChangeId={focusedChangeId}
      />
    </div>
  )
}

/** Embedded preview of TerminalPreviewOverlay */
export function TerminalPreviewOverlayPlayground({
  command,
  output,
  exitCode,
  toolType,
  description,
  error,
}: {
  command: string
  output: string
  exitCode?: number | undefined
  toolType?: 'bash' | 'grep' | 'glob' | undefined
  description?: string | undefined
  error?: string | undefined
}) {
  return (
    <div className="h-[500px]">
      <TerminalPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        command={command}
        output={output}
        exitCode={exitCode}
        toolType={toolType}
        description={description}
        error={error}
      />
    </div>
  )
}

/** Embedded preview of JSONPreviewOverlay */
export function JSONPreviewOverlayPlayground({
  data,
  title,
  error,
}: {
  data: unknown
  title?: string | undefined
  error?: string | undefined
}) {
  return (
    <div className="h-[500px]">
      <JSONPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        data={data}
        title={title}
        error={error}
      />
    </div>
  )
}

/** Embedded preview of GenericOverlay */
export function GenericOverlayPlayground({
  content,
  title,
}: {
  content: string
  title?: string | undefined
}) {
  return (
    <div className="h-[500px]">
      <GenericOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        title={title}
      />
    </div>
  )
}

// ============================================================================
// Data Table Overlay - Playground Wrapper
// ============================================================================

/** Sample table component rendered inside DataTableOverlay */
function SampleDataTable() {
  const rows = [
    { tool: 'Read', permission: 'allowed', description: 'Read files from disk' },
    { tool: 'Write', permission: 'ask', description: 'Write files to disk' },
    { tool: 'Edit', permission: 'ask', description: 'Edit existing files' },
    { tool: 'Bash', permission: 'ask', description: 'Execute shell commands' },
    { tool: 'Grep', permission: 'allowed', description: 'Search file contents' },
    { tool: 'Glob', permission: 'allowed', description: 'Find files by pattern' },
    { tool: 'WebFetch', permission: 'allowed', description: 'Fetch URL content' },
    { tool: 'WebSearch', permission: 'blocked', description: 'Search the web' },
  ]

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Tool</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Permission</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.tool} className="border-b border-border/50">
            <td className="py-2 px-4 font-mono text-xs">{row.tool}</td>
            <td className="py-2 px-4">
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                row.permission === 'allowed' ? 'bg-green-500/10 text-green-600' :
                row.permission === 'ask' ? 'bg-amber-500/10 text-amber-600' :
                'bg-red-500/10 text-red-600'
              }`}>
                {row.permission}
              </span>
            </td>
            <td className="py-2 px-4 text-muted-foreground">{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Wrapper with button to open DataTableOverlay */
export function DataTableOverlayPlayground({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string | undefined
}) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        Open Data Table
      </button>
      <DataTableOverlay
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={title}
        subtitle={subtitle}
      >
        <SampleDataTable />
      </DataTableOverlay>
    </div>
  )
}
