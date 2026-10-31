

import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, XCircle, Circle, CircleDashed, Pencil, FilePenLine } from 'lucide-react';
import { cn } from '../../lib/utils';

import { Spinner } from '../ui/LoadingIndicator';

import { SIZE_CONFIG, type ActivityStatus, type ActivityItem } from "./turn-card-contracts";

export function ActivityStatusIcon({
  status,
  toolName,
  customIcon
}: {
  status: ActivityStatus
  toolName?: string | undefined
  /** Custom icon from tool metadata - emoji or data URL (base64) */
  customIcon?: string | undefined
}) {
  // Render the appropriate icon based on status
  const renderIcon = () => {
    // For completed status with custom icon, use it instead of checkmark
    if (status === 'completed' && customIcon) {
      // Check if it's an emoji (short string, not a URL or data URL)
      // Emojis can be 1-4+ characters due to ZWJ sequences
      const isLikelyEmoji = customIcon.length <= 8 && !/^(https?:\/\/|data:)/.test(customIcon)
      if (isLikelyEmoji) {
        return (
          <span className={cn(SIZE_CONFIG.iconSize, "shrink-0 flex items-center justify-center text-[10px] leading-none")}>
            {customIcon}
          </span>
        )
      }
      // Otherwise it's a data URL (base64) or HTTP URL
      return (
        <img
          src={customIcon}
          alt=""
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 rounded-sm object-contain")}
        />
      )
    }

    // Default icon logic
    switch (status) {
      case 'pending':
        return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
      case 'running':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={SIZE_CONFIG.spinnerSize} />
          </div>
        )
      case 'backgrounded':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={cn(SIZE_CONFIG.spinnerSize, "text-accent")} />
          </div>
        )
      case 'checkpoint':
        return <CircleDashed className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground")} />
      case 'completed':
        // Edit and Write tools get their own icons with accent color instead of green checkmark
        if (toolName === 'Edit') {
          return <Pencil className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        if (toolName === 'Write') {
          return <FilePenLine className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        return <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")} />
      case 'error':
        return <XCircle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-destructive")} />
    }
  }

  // Wrap in AnimatePresence for crossfade between states
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="shrink-0"
      >
        {renderIcon()}
      </motion.div>
    </AnimatePresence>
  )
}

export interface ActivityRowProps {
  activity: ActivityItem
  /** Callback to open activity details in Monaco */
  onOpenDetails?: (() => void) | undefined
  /** Whether this is the last child at its depth level (for └ corner in tree view) */
  isLastChild?: boolean | undefined
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string | undefined
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed' | undefined
}

export function TreeViewConnector({ depth }: { depth: number; isLastChild?: boolean | undefined }) {
  if (depth === 0) return null

  // Just add indentation based on depth, no connectors
  return (
    <div className="flex self-stretch">
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} className="w-4 shrink-0" />
      ))}
    </div>
  )
}
