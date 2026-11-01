import * as React from 'react';
import "react-i18next";
import { cn } from '@/lib/utils';
import "@/components/ui/popover";
import "@/components/ui/slash-command-menu";
import "lucide-react";
import "@craft-agent/shared/agent/modes";
import { ActiveTasksBar } from './ActiveTasksBar';
import "@/components/ui/label-icon";
import "@/components/ui/label-value-popover";
import { flattenLabels, parseLabelEntry, formatLabelEntry } from '@craft-agent/shared/labels';
import "@craft-agent/shared/colors";
import "@/context/ThemeContext";
import { useDynamicStack } from '@/hooks/useDynamicStack';
import { getState } from '@/config/session-status-config';
import "@/components/ui/session-status-menu";
import "@/components/ui/metadata-badge";
import "@/lib/open-label-link";
import "./SessionInfoPopover";

import { type ActiveOptionBadgesProps, type ResolvedLabelEntry, LabelBadge, StateBadge, FilesPopoverButton, PermissionModeDropdown } from "./active-option-controls";
export { type ActiveOptionBadgesProps } from "./active-option-controls";























export function ActiveOptionBadges({
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  onShowTerminalOverlay,
  sessionLabels = [],
  labels = [],
  onRemoveLabel,
  onLabelsChange,
  autoOpenLabelId,
  onAutoOpenConsumed,
  sessionStatuses = [],
  currentSessionStatus,
  onSessionStatusChange,
  className,
}: ActiveOptionBadgesProps) {
  // Resolve session label entries to their config objects + parsed values.
  // Entries may be bare IDs ("bug") or valued ("priority::3").
  // Preserves the raw value and original index for editing/removal.
  const resolvedLabels = React.useMemo((): ResolvedLabelEntry[] => {
    if (sessionLabels.length === 0 || labels.length === 0) return []
    const flat = flattenLabels(labels)
    const result: ResolvedLabelEntry[] = []
    for (const [i, entry] of sessionLabels.entries()) {
      const parsed = parseLabelEntry(entry)
      const config = flat.find(l => l.id === parsed.id)
      if (config) {
        result.push({ config, ...(parsed.rawValue !== undefined ? { rawValue: parsed.rawValue } : {}), index: i })
      }
    }
    return result
  }, [sessionLabels, labels])

  const hasLabels = resolvedLabels.length > 0

  // Resolve the current state from sessionStatuses for the badge display.
  // Every session always has a state — fall back to the default state (or 'todo')
  // when currentSessionStatus isn't explicitly set, matching SessionList's behavior.
  const effectiveStateId = currentSessionStatus || 'todo'
  const resolvedState = sessionStatuses.length > 0 ? getState(effectiveStateId, sessionStatuses) : undefined
  const hasState = !!resolvedState

  // Show the stacking container when there are labels (state badge is now rendered standalone on the left)
  const hasStackContent = hasLabels

  // Dynamic stacking with equal visible strips: ResizeObserver computes per-badge
  // margins directly on children. Wider badges get more negative margins so each
  // shows the same visible strip when stacked. No React re-renders needed.
  const stackRef = useDynamicStack({ gap: 8, minVisible: 20, reservedStart: 0 })

  // Only render if badges or tasks are active
  if (!permissionMode && tasks.length === 0 && !hasState && !hasStackContent) {
    return null
  }

  return (
    <>
      {/* Background tasks row — running / done / orphaned chips. Rendered above the
       * options row so a growing number of tasks wraps without disturbing the
       * mode/label badges. Only present when there are active/recent tasks. */}
      {tasks.length > 0 && sessionId && (
        <div className="flex items-center flex-wrap gap-2 mb-2 px-px">
          <ActiveTasksBar
            tasks={tasks}
            sessionId={sessionId}
            onKillTask={onKillTask}
            onInsertMessage={onInsertMessage}
            onShowTerminalOverlay={onShowTerminalOverlay}
          />
        </div>
      )}

    <div className={cn("flex items-start gap-2 mb-2 px-px pt-px pb-0.5", className)}>
      {/* Left side: mode → state → labels stack */}
      <div className="flex items-start gap-2 min-w-0 flex-1">
        {/* Permission Mode Badge */}
        {permissionMode && (
          <div className="shrink-0">
            <PermissionModeDropdown
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* State Badge — standalone on the left, after Mode */}
        {hasState && resolvedState && (
          <div className="shrink-0">
            <StateBadge
              state={resolvedState}
              sessionStatuses={sessionStatuses}
              onSessionStatusChange={onSessionStatusChange}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* Stacking container for label badges (left side).
         * useDynamicStack sets per-child marginLeft directly via ResizeObserver.
         * overflow: clip prevents scroll container while py/-my gives shadow room. */}
        {hasStackContent && (
          <div
            className="flex-1 min-w-0 max-w-full py-0.5 -my-0.5"
            style={{
              // shadow-minimal replicated as drop-shadow (traces masked alpha, no clipping).
              // Ring uses higher blur+opacity for visible border feel (hard 1px ring can't be replicated exactly).
              // Blur shadows use reduced blur+opacity to stay tight (accounting for no negative spread in drop-shadow).
              filter: 'drop-shadow(0px 0px 0.5px rgba(var(--foreground-rgb), 0.3)) drop-shadow(0px 1px 0.1px rgba(0,0,0,0.04)) drop-shadow(0px 3px 0.2px rgba(0,0,0,0.03))',
            }}
          >
            <div
              ref={stackRef}
              className="flex items-center min-w-0 py-1 -my-1"
              style={{ overflow: 'clip' }}
            >
              {/* Label badges */}
              {resolvedLabels.map(({ config, rawValue, index }) => (
                <LabelBadge
                  key={`${config.id}-${index}`}
                  label={config}
                  value={rawValue}
                  autoOpen={config.id === autoOpenLabelId}
                  onAutoOpenConsumed={onAutoOpenConsumed}
                  sessionId={sessionId}
                  onValueChange={(newValue) => {
                    // Rebuild the sessionLabels array with the updated entry
                    const updated = [...sessionLabels]
                    updated[index] = formatLabelEntry(config.id, newValue)
                    onLabelsChange?.(updated)
                  }}
                  onRemove={() => {
                    if (onLabelsChange) {
                      onLabelsChange(sessionLabels.filter((_, i) => i !== index))
                    } else {
                      onRemoveLabel?.(config.id)
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Right side: Files popover button */}
      <div className="shrink-0">
        <FilesPopoverButton sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </div>
    </div>
    </>
  )
}
