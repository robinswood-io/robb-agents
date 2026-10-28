import * as React from 'react';

import i18n from 'i18next';

import { normalizePath } from '@craft-agent/core/utils';

import { CheckCircle2, MessageCircleDashed, ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';

import { Spinner } from '../ui/LoadingIndicator';

import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip';

import { formatDuration } from './turn-utils';

import { stripMarkdown, computeEditWriteDiffStats, SIZE_CONFIG } from "./turn-card-contracts";

import { formatToolInput, formatToolDisplay } from "./turn-card-tool-display";
import { ActivityStatusIcon, type ActivityRowProps, TreeViewConnector } from "./turn-card-activity-icon";

export function ActivityRow({ activity, onOpenDetails, isLastChild, sessionFolderPath, displayMode = 'detailed' }: ActivityRowProps) {
  const depth = activity.depth || 0

  // Intermediate messages (LLM commentary) - render with dashed circle icon
  // Show "Thinking" while streaming, stripped markdown content when complete
  if (activity.type === 'intermediate') {
    const isThinking = activity.status === 'running'
    const displayContent = isThinking ? 'Thinking...' : stripMarkdown(activity.content || '')
    const isComplete = activity.status === 'completed'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "group/row flex items-center gap-2 py-0.5 text-foreground/75 flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
          onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
        >
          {isThinking ? (
            <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
              <Spinner className={SIZE_CONFIG.spinnerSize} />
            </div>
          ) : (
            <MessageCircleDashed className={cn(SIZE_CONFIG.iconSize, "shrink-0")} />
          )}
          <span className={cn("truncate flex-1", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayContent}</span>
          {/* Open details button */}
          {onOpenDetails && isComplete && (
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  onOpenDetails()
                }
              }}
              className={cn(
                "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
                "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
            >
              <ArrowUpRight className={SIZE_CONFIG.iconSize} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // Status activities (e.g., compacting) - system-level with distinct styling
  if (activity.type === 'status') {
    const isRunning = activity.status === 'running'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
        >
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            {isRunning ? (
              <Spinner className={SIZE_CONFIG.spinnerSizeSmall} />
            ) : (
              <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "text-success")} />
            )}
          </div>
          <span className="truncate">{activity.content}</span>
        </div>
      </div>
    )
  }

  // Tool activities - show with status icon
  // Format: "[DisplayName] · [Intent/Description] [Params]"
  // - DisplayName: From toolDisplayMeta (embedded in message) or LLM-generated or fallback
  // - Intent: For MCP tools (activity.intent), for Bash (toolInput.description)
  // - Params: Remaining tool input summary
  const toolDisplay = formatToolDisplay(activity)
  const fullDisplayName = toolDisplay.name
    || (activity.type === 'thinking' ? 'Thinking' : 'Processing')

  // Detect MCP/API tools (toolName starts with "mcp__")
  const isMcpOrApiTool = activity.toolName?.startsWith('mcp__') ?? false

  // For MCP/API tools, extract source name and tool slug
  // e.g., "ClickUp: clickup_search" -> sourceName="ClickUp", toolSlug="clickup_search"
  let sourceName = fullDisplayName
  let toolSlug: string | undefined = undefined
  if (isMcpOrApiTool) {
    const colonIndex = fullDisplayName.indexOf(':')
    if (colonIndex > 0) {
      sourceName = fullDisplayName.substring(0, colonIndex).trim()
      toolSlug = fullDisplayName.substring(colonIndex + 1).trim()
    }
  }

  // For non-MCP tools or informative mode, use the appropriate display name
  const displayedName: string = isMcpOrApiTool ? sourceName : fullDisplayName

  // Intent for MCP tools, description for Bash commands
  const intentOrDescription = activity.intent || (activity.toolInput?.["description"] as string | undefined)
  const inputSummary = formatToolInput(activity.toolInput, activity.toolName, sessionFolderPath)
  const diffStats = computeEditWriteDiffStats(activity.toolName, activity.toolInput)
  const isCheckpoint = activity.status === 'checkpoint'
  const visibleDiffStats = isCheckpoint ? null : diffStats
  const isComplete = activity.status === 'completed' || activity.status === 'error' || isCheckpoint
  const isBackgrounded = activity.status === 'backgrounded'

  // For backgrounded tasks, show task/shell ID and elapsed time
  const backgroundInfo = isBackgrounded
    ? activity.taskId
      ? `Task ID: ${activity.taskId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
      : activity.shellId
        ? `Shell ID: ${activity.shellId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
        : null
    : null

  return (
    <div className="flex items-stretch">
      <TreeViewConnector depth={depth} isLastChild={isLastChild} />
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 px-1.5 -mx-1.5 rounded-[6px] text-muted-foreground flex-1 min-w-0 transition-colors",
          onOpenDetails && isComplete && "cursor-pointer hover:bg-muted/40 hover:text-foreground",
          SIZE_CONFIG.fontSize
        )}
        onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
      >
        <ActivityStatusIcon status={activity.status} toolName={activity.toolName} customIcon={toolDisplay.icon} />
        {isCheckpoint && (
          <span
            data-tool-execution="checkpoint"
            className="shrink-0 rounded-[4px] bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {i18n.t('turnCard.notExecutedAutoResume')}
          </span>
        )}
        {/* MCP/API tools: Source name (shrink-0) then error badge (if any) then compound label (flex-1) */}
        {isMcpOrApiTool && !isBackgrounded && (
          <>
            <span className="shrink-0">{sourceName}</span>
            {/* Error badge for MCP/API tools */}
            {activity.status === 'error' && activity.error && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                    style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                  >
                    {i18n.t('common.error')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[400px]">
                  {activity.error}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Model badge for LLM Query */}
            {activity.toolName === 'mcp__session__call_llm' && activity.toolInput?.["model"] && (
              <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[10px] text-foreground/60 shrink-0">
                {String(activity.toolInput["model"])}
              </span>
            )}
            {(intentOrDescription || (displayMode === 'detailed' && (toolSlug || inputSummary))) && (
              <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
                {intentOrDescription && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span>{intentOrDescription}</span>
                  </>
                )}
                {displayMode === 'detailed' && toolSlug && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-70">{toolSlug}</span>
                  </>
                )}
                {displayMode === 'detailed' && inputSummary && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-50">{inputSummary}</span>
                  </>
                )}
              </span>
            )}
          </>
        )}
        {/* Native tools: Tool name (shrink-0) */}
        {!isMcpOrApiTool && (
          <span className={cn("shrink-0", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayedName}</span>
        )}
        {/* Diff stats and filename badges - after tool name */}
        {!isMcpOrApiTool && !isBackgrounded && visibleDiffStats && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            {visibleDiffStats.deletions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted rounded-[4px] text-destructive"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >{visibleDiffStats.deletions}</span>
            )}
            {visibleDiffStats.additions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--success)_5%,var(--background))] shadow-tinted rounded-[4px] text-success"
                style={{ '--shadow-color': 'var(--success-rgb)' } as React.CSSProperties}
              >{visibleDiffStats.additions}</span>
            )}
            {/* Filename badge - supports both Claude Code and Codex formats */}
            {(() => {
              // Claude Code format: file_path
              if (typeof activity.toolInput?.["file_path"] === 'string') {
                return (
                  <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                    {normalizePath(activity.toolInput["file_path"]).split('/').pop()}
                  </span>
                )
              }
              // Codex format: changes[0].path
              if (Array.isArray(activity.toolInput?.["changes"])) {
                const firstChange = activity.toolInput["changes"][0] as { path?: string } | undefined
                if (firstChange?.path) {
                  return (
                    <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                      {normalizePath(firstChange.path).split('/').pop()}
                    </span>
                  )
                }
              }
              return null
            })()}
          </span>
        )}
        {/* Filename badge for Read tool (no diff stats) */}
        {!isMcpOrApiTool && !isBackgrounded && !visibleDiffStats && activity.toolName === 'Read' && typeof activity.toolInput?.["file_path"] === 'string' && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
              {normalizePath(activity.toolInput["file_path"]).split('/').pop()}
            </span>
          </span>
        )}
        {/* Error badge for native tools */}
        {!isMcpOrApiTool && activity.status === 'error' && activity.error && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >
                Error
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[400px]">
              {activity.error}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Native tools: Compound label with description + params (flex-1) */}
        {/* In informative mode, hide inputSummary (command details) - only show description */}
        {!isMcpOrApiTool && !isBackgrounded && (intentOrDescription || (displayMode === 'detailed' && inputSummary)) && (
          <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
            {intentOrDescription && (
              <>
                <span className="opacity-60"> · </span>
                <span>{intentOrDescription}</span>
              </>
            )}
            {displayMode === 'detailed' && inputSummary && (
              <>
                <span className="opacity-60"> · </span>
                <span className="opacity-50">{inputSummary}</span>
              </>
            )}
          </span>
        )}
        {/* Background task info (task/shell ID + elapsed time) */}
        {backgroundInfo && (
          <>
            <span className="opacity-60 shrink-0">·</span>
            <span className="truncate min-w-0 max-w-[300px] text-accent">{backgroundInfo}</span>
          </>
        )}
        {/* No spacer needed - both MCP/API and native tools now have flex-1 on their compound spans */}
        {/* Open details button */}
        {onOpenDetails && isComplete && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetails()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenDetails()
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </div>
        )}
      </div>
    </div>
  )
}
