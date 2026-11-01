import type { HandleErrorMessageActionOptions } from './error-message-actions.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from "react";
import { useTranslation } from "react-i18next";

import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, ExternalLink, Info } from "lucide-react";

import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { Markdown, CollapsibleMarkdownProvider, StreamingMarkdown, type RenderMode } from "@/components/markdown";
import { AnimatedCollapsibleContent } from "@/components/ui/collapsible";
import { Spinner } from "@craft-agent/ui";

import type { Message } from "../../../shared/types";

import { UserMessageBubble } from "@craft-agent/ui";

import { handleErrorMessageAction } from "./error-message-actions";

export interface MessageBubbleProps {
  message: Message
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  sessionId?: string | undefined
  /**
   * Markdown render mode for assistant messages
   * @default 'minimal'
   */
  renderMode?: RenderMode | undefined
  /**
   * Callback to pop out message into a separate window
   */
  onPopOut?: ((message: Message) => void) | undefined
  /** Compact mode - reduces padding for popover embedding */
  compactMode?: boolean | undefined
  /** Callback to resume an existing request without adding a user message. */
  onRetry?: (() => void) | undefined
}

export function ErrorMessage({ message, onOpenUrl, sessionId, onRetry }: { message: Message; onOpenUrl?: ((url: string) => void) | undefined; sessionId?: string | undefined; onRetry?: (() => void) | undefined }) {
  const { t } = useTranslation()
  const hasDetails = (message.errorDetails && message.errorDetails.length > 0) || message.errorOriginal
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const actions = message.errorActions?.filter(a => {
    // The request summary owns its anchored retry; never resend message text
    // or leave a second button that merely focuses the composer.
    if (a.action === 'retry') return !!onRetry
    if (a.action === 'open_url') return !!a.url && !!onOpenUrl
    if (a.action === 'reconnect_runtime') return !!sessionId
    return true
  })
  const handleReconnectRuntime = React.useCallback(() => {
    if (!sessionId) return
    void window.electronAPI.sessionCommand(sessionId, { type: 'restartRuntime' }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(t('toast.reconnectFailed'), { description: detail })
    })
  }, [sessionId, t])

  return (
    <div className="flex justify-start mt-4">
      {/* Subtle bg (3% opacity) + tinted shadow for softer error appearance */}
      <div
        className="max-w-[80%] shadow-tinted rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words"
        style={{
          backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
          '--shadow-color': 'var(--destructive-rgb)',
        } as React.CSSProperties}
      >
        <div className="text-xs text-destructive/50 mb-0.5 font-semibold">
          {message.errorTitle || t('common.error')}
        </div>
        <p className="text-sm text-destructive">{message.content}</p>

        {/* Action buttons */}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <button
                key={action.key}
                onClick={() => {
                  handleErrorMessageAction(action, omitUndefined<HandleErrorMessageActionOptions>({
                    sessionId,
                    onOpenUrl,
                    onRetry,
                    onReconnectRuntime: handleReconnectRuntime,
                  }))
                }}
                className="text-xs px-2 py-0.5 rounded border border-destructive/20 text-destructive/70 hover:text-destructive hover:border-destructive/40 transition-colors"
              >
                {action.label}{action.action === 'open_url' ? ' ↗' : ''}
              </button>
            ))}
          </div>
        )}

        {/* Collapsible Details Toggle */}
        {hasDetails && (
          <div className="mt-2">
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive transition-colors"
            >
              {detailsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <span>{detailsOpen ? t('chat.hideTechnicalDetails') : t('chat.showTechnicalDetails')}</span>
            </button>

            <AnimatedCollapsibleContent isOpen={detailsOpen} className="overflow-hidden">
              <div className="mt-2 pt-2 border-t border-destructive/20 text-xs text-destructive/60 font-mono space-y-0.5">
                {message.errorDetails?.map((detail, i) => (
                  <div key={i}>{detail}</div>
                ))}
                {message.errorOriginal && !message.errorDetails?.some(d => d.includes('Raw error:')) && (
                  <div className="mt-1">Raw: {message.errorOriginal.slice(0, 200)}{message.errorOriginal.length > 200 ? '...' : ''}</div>
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}
      </div>
    </div>
  )
}

export function MessageBubble({
  message,
  onOpenFile,
  onOpenUrl,
  sessionId,
  renderMode = 'minimal',
  onPopOut,
  compactMode,
  onRetry,
}: MessageBubbleProps) {
  const { t } = useTranslation()

  // === USER MESSAGE: Right-aligned bubble with attachments above ===
  if (message.role === 'user') {
    return (
      <UserMessageBubble
        content={message.content}
        attachments={message.attachments}
        badges={message.badges}
        isPending={message.isPending}
        isQueued={message.isQueued}
        onUrlClick={onOpenUrl}
        onFileClick={onOpenFile}
        compactMode={compactMode}
      />
    )
  }

  // === ASSISTANT MESSAGE: Left-aligned gray bubble with markdown rendering ===
  if (message.role === 'assistant') {
    return (
      <div className="flex justify-start group">
        <div className="relative max-w-[90%] bg-background shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0 select-text">
          {/* Pop-out button - visible on hover */}
          {onPopOut && !message.isStreaming && (
            <button
              onClick={() => onPopOut(message)}
              data-touch-reveal="true"
              className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
              title={t("sidebarMenu.openInNewWindow")}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </button>
          )}
          {/* Use StreamingMarkdown for block-level memoization during streaming */}
          {message.isStreaming ? (
            <StreamingMarkdown
              content={message.content}
              isStreaming={true}
              mode={renderMode}
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            />
          ) : (
            <CollapsibleMarkdownProvider>
              <Markdown
                mode={renderMode}
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
                id={message.id}
                className="text-sm"
                collapsible
              >
                {message.content}
              </Markdown>
            </CollapsibleMarkdownProvider>
          )}
        </div>
      </div>
    )
  }

  // === ERROR MESSAGE: Red bordered bubble with warning icon and collapsible details ===
  if (message.role === 'error') {
    return <ErrorMessage message={message} onOpenUrl={onOpenUrl} sessionId={sessionId} onRetry={onRetry} />
  }

  // === STATUS MESSAGE: Matches ProcessingIndicator layout for visual consistency ===
  if (message.role === 'status') {
    return (
      <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
        {/* Spinner in same location as TurnCard chevron */}
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Spinner className="text-[10px]" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === INFO MESSAGE: Icon and color based on level ===
  if (message.role === 'info') {
    // Compaction complete message - render as horizontal rule with centered label
    // This persists after reload to show where context was compacted
    if (message.statusType === 'compaction_complete') {
      return (
        <div className="flex items-center gap-3 my-12 px-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-sm text-muted-foreground/70 select-none">
            Conversation Compacted
          </span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )
    }

    const level = message.infoLevel || 'info'
    const config = {
      info: { icon: Info, className: 'text-muted-foreground' },
      warning: { icon: AlertTriangle, className: 'text-info' },
      error: { icon: CircleAlert, className: 'text-destructive' },
      success: { icon: CheckCircle2, className: 'text-success' },
    }[level]
    const Icon = config.icon

    return (
      <div className={cn('flex items-center gap-2 px-3 py-1 text-[13px] select-none', config.className)}>
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Icon className="w-3 h-3" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === WARNING MESSAGE: Info themed bubble ===
  if (message.role === 'warning') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-info/10 rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words select-none">
          <div className="text-xs text-info/50 mb-0.5 font-semibold">
            Warning
          </div>
          <p className="text-sm text-info">{message.content}</p>
        </div>
      </div>
    )
  }

  return null
}

export const MemoizedMessageBubble = React.memo(MessageBubble, (prev, next) => {
  // Always re-render streaming messages (content is changing)
  if (prev.message.isStreaming || next.message.isStreaming) {
    return false
  }
  // Skip re-render if key props unchanged
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    prev.sessionId === next.sessionId &&
    prev.compactMode === next.compactMode
  )
})
