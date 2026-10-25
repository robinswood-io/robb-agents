import * as React from "react";
import { Markdown, CollapsibleMarkdownProvider, Spinner } from "@craft-agent/ui";
import { ExternalLink } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

// ============================================================================
// Message Components - Demo components for playground preview
// Uses shared components from @craft-agent/ui where available
// ============================================================================

/** Assistant message bubble - left aligned white card (playground demo version) */
export function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-start group">
      <div className="relative max-w-[80%] bg-white shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0">
        <button
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
          title="Open in new window"
        >
          <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
        </button>
        <CollapsibleMarkdownProvider>
          <Markdown
            mode="minimal"
            className="text-sm"
            collapsible
          >
            {content}
          </Markdown>
        </CollapsibleMarkdownProvider>
      </div>
    </div>
  )
}

/** Status message - spinner with text, used during compaction etc (playground demo) */
export function StatusMessage({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[13px] text-muted-foreground">
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      <span>{content}</span>
    </div>
  )
}

/** Compaction divider - horizontal rule with centered label shown after context compaction (playground demo) */
export function CompactionDivider({ label = 'Conversation Compacted' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 my-12 px-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-sm text-muted-foreground/70 select-none">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/** Processing indicator with cycling messages and elapsed time */
const PROCESSING_MESSAGES = [
  'Thinking…',
  'Pondering…',
  'Contemplating…',
  'Reasoning…',
  'Processing…',
  'Computing…',
  'Considering…',
  'Reflecting…',
  'Deliberating…',
  'Cogitating…',
  'Ruminating…',
  'Musing…',
  'Working on it…',
  'On it…',
  'Crunching…',
  'Brewing…',
  'Connecting dots…',
  'Mulling it over…',
  'Deep in thought…',
  'Hmm…',
  'Let me see…',
  'One moment…',
  'Hold on…',
  'Bear with me…',
  'Just a sec…',
  'Hang tight…',
  'Getting there…',
  'Almost…',
  'Working…',
  'Busy busy…',
  'Whirring…',
  'Churning…',
  'Percolating…',
  'Simmering…',
  'Cooking…',
  'Baking…',
  'Stirring…',
  'Spinning up…',
  'Warming up…',
  'Revving…',
  'Buzzing…',
  'Humming…',
  'Ticking…',
  'Clicking…',
  'Whizzing…',
  'Zooming…',
  'Zipping…',
  'Chugging…',
  'Trucking…',
  'Rolling…',
]

interface ProcessingIndicatorProps {
  /** Animation cycle duration in milliseconds */
  cycleMs?: number
  /** Whether the elapsed counter should count automatically */
  counting?: boolean
  /** Initial elapsed time (only used if counting is false) */
  elapsed?: number
}

export function ProcessingIndicator({ cycleMs = 10000, counting = true, elapsed: initialElapsed = 0 }: ProcessingIndicatorProps) {
  const [elapsed, setElapsed] = React.useState(initialElapsed)
  const [messageIndex, setMessageIndex] = React.useState(() =>
    Math.floor(Math.random() * PROCESSING_MESSAGES.length)
  )
  const startTimeRef = React.useRef(Date.now())

  // Update elapsed time every second (only if counting)
  React.useEffect(() => {
    if (!counting) return
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [counting])

  // Cycle through messages based on cycleMs
  React.useEffect(() => {
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        // Pick a random different message
        let next = Math.floor(Math.random() * PROCESSING_MESSAGES.length)
        while (next === prev && PROCESSING_MESSAGES.length > 1) {
          next = Math.floor(Math.random() * PROCESSING_MESSAGES.length)
        }
        return next
      })
    }, cycleMs)
    return () => clearInterval(interval)
  }, [cycleMs])

  const currentMessage = PROCESSING_MESSAGES[messageIndex]

  const labelRef = React.useRef<HTMLSpanElement>(null)
  const [labelWidth, setLabelWidth] = React.useState<number | 'auto'>('auto')

  // Measure label width when message changes (not when counter changes)
  React.useLayoutEffect(() => {
    if (labelRef.current) {
      setLabelWidth(labelRef.current.offsetWidth)
    }
  }, [currentMessage])

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[13px] text-muted-foreground">
      {/* Spinner */}
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      {/* Label container */}
      <span className="inline-flex items-center h-5">
        {/* Animated width container - only animates when label changes */}
        <motion.span
          className="relative inline-block h-5"
          animate={{ width: labelWidth }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* True crossfade for label only */}
          <AnimatePresence initial={false}>
            <motion.span
              ref={labelRef}
              key={currentMessage}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="absolute left-0 top-0 h-5 flex items-center whitespace-nowrap"
            >
              {currentMessage}
            </motion.span>
          </AnimatePresence>
        </motion.span>
        {/* Counter - no animation, just updates instantly */}
        {elapsed >= 1 && (
          <span className="text-muted-foreground/60 ml-1 tabular-nums">
            {elapsed}s
          </span>
        )}
      </span>
    </div>
  )
}
