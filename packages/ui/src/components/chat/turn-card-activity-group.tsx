
import { useCallback, useState } from 'react';
import i18n from 'i18next';

import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';

import { formatDuration, formatTokens, type ActivityGroup } from './turn-utils';

import { SIZE_CONFIG, type ActivityItem } from "./turn-card-contracts";

import { ActivityStatusIcon } from "./turn-card-activity-icon";
import { ActivityRow } from "./turn-card-activity-row";

export interface ActivityGroupRowProps {
  group: ActivityGroup
  /** Controlled expansion state for activity groups */
  expandedGroups?: Set<string>
  /** Callback when expansion changes */
  onExpandedGroupsChange?: (groups: Set<string>) => void
  /** Callback to open activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Animation index for staggered animation */
  animationIndex?: number
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
}

export function ActivityGroupRow({ group, expandedGroups: externalExpandedGroups, onExpandedGroupsChange, onOpenActivityDetails, animationIndex = 0, sessionFolderPath, displayMode = 'detailed' }: ActivityGroupRowProps) {
  // Use local state if no controlled state provided
  const [localExpandedGroups, setLocalExpandedGroups] = useState<Set<string>>(new Set())
  const expandedGroups = externalExpandedGroups ?? localExpandedGroups
  const setExpandedGroups = onExpandedGroupsChange ?? setLocalExpandedGroups

  const groupId = group.parent.id
  const isExpanded = expandedGroups.has(groupId)

  const toggleExpanded = useCallback(() => {
    const next = new Set(expandedGroups)
    if (next.has(groupId)) {
      next.delete(groupId)
    } else {
      next.add(groupId)
    }
    setExpandedGroups(next)
  }, [groupId, expandedGroups, setExpandedGroups])

  const description = group.parent.toolInput?.description as string | undefined
  const subagentType = group.parent.toolInput?.subagent_type as string | undefined
  const isCheckpoint = group.parent.status === 'checkpoint'
  const isComplete = group.parent.status === 'completed' || group.parent.status === 'error' || isCheckpoint
  const hasError = group.parent.status === 'error'

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: animationIndex < SIZE_CONFIG.staggeredAnimationLimit ? animationIndex * 0.03 : 0.3 }}
      className="space-y-0.5"
    >
      {/* Task header row - no left padding, chevron aligned with activity row icons */}
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 rounded-md cursor-pointer text-muted-foreground",
          "hover:text-foreground transition-colors",
          SIZE_CONFIG.fontSize
        )}
        onClick={toggleExpanded}
      >
        {/* Chevron for expand/collapse - aligned with activity row icons */}
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </motion.div>

        {/* Status icon - aligned with tool call icons */}
        <ActivityStatusIcon status={group.parent.status} toolName={group.parent.toolName} />

        {isCheckpoint && (
          <span
            data-tool-execution="checkpoint"
            className="shrink-0 rounded-[4px] bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {i18n.t('turnCard.notExecutedAutoResume')}
          </span>
        )}

        {/* Subagent type badge */}
        <span className="shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium">
          {subagentType || 'Task'}
        </span>

        {/* Task description or fallback */}
        <span className={cn(
          "truncate",
          hasError && "text-destructive"
        )}>
          {description || 'Task'}
        </span>

        {/* Duration and token stats from TaskOutput (only when complete) */}
        {isComplete && group.taskOutputData && (
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
            {group.taskOutputData.durationMs !== undefined && (
              <span>{formatDuration(group.taskOutputData.durationMs)}</span>
            )}
            {group.taskOutputData.durationMs !== undefined &&
              (group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span className="mx-1">·</span>
            )}
            {(group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span>
                {formatTokens((group.taskOutputData.inputTokens || 0) + (group.taskOutputData.outputTokens || 0))} tokens
              </span>
            )}
          </span>
        )}

        {/* Spacer to push details button to right */}
        <span className="flex-1" />

        {/* Open details button for the Task itself */}
        {onOpenActivityDetails && isComplete && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onOpenActivityDetails(group.parent)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenActivityDetails(group.parent)
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

      {/* Children with indentation */}
      <AnimatePresence initial={false}>
        {isExpanded && group.children.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            <div className="pl-0 space-y-0.5 border-l-2 border-muted ml-[5px]">
              {group.children.map((child, idx) => (
                <motion.div
                  key={child.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.02 }}
                  className="ml-[-4px]"
                >
                  <ActivityRow
                    activity={child}
                    onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(child) : undefined}
                    isLastChild={idx === group.children.length - 1}
                    sessionFolderPath={sessionFolderPath}
                    displayMode={displayMode}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
