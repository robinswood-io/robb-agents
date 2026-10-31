/**
 * UserMessageBubble - Shared user message component
 *
 * Displays user messages with right-aligned styling:
 * - Subtle background (5% foreground)
 * - Pill-shaped corners
 * - Max width 80%
 * - Markdown rendering for links and code
 * - Optional file attachments with thumbnails
 * - Content badges for @mentions (sources, skills)
 * - Pending/queued states (Electron only)
 */

import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import "@craft-agent/core/utils";
import { cn } from '../../lib/utils';
import { Markdown } from '../markdown';
import { FileTypeIcon, getFileTypeLabel } from './attachment-helpers';
import "../tooltip";
import { useTranslation } from 'react-i18next';

import { isEditRequestBadge, EditRequestBadge, renderContentWithBadges, type UserMessageBubbleProps, QUEUED_MIN_VISIBLE_MS } from "./user-message-badges";
export { type UserMessageBubbleProps } from "./user-message-badges";










export function UserMessageBubble({
  content,
  className,
  onUrlClick,
  onFileClick,
  attachments,
  badges,
  isQueued,
  compactMode,
}: UserMessageBubbleProps) {
  const { t } = useTranslation()
  const hasAttachments = attachments && attachments.length > 0

  // Show the queued chip while `isQueued` is true AND for at least
  // QUEUED_MIN_VISIBLE_MS after it first became true — even if the backend
  // acks in <150ms. Pure UI state; `isQueued` remains the persisted source
  // of truth.
  const [showQueued, setShowQueued] = useState(isQueued ?? false)
  const queuedShownAtRef = useRef<number | null>(isQueued ? Date.now() : null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }

    if (isQueued) {
      setShowQueued(true)
      if (queuedShownAtRef.current === null) {
        queuedShownAtRef.current = Date.now()
      }
      return
    }

    // isQueued flipped to false. Keep the chip up for the remainder of
    // the minimum visible window, then clear.
    if (queuedShownAtRef.current === null) return

    const elapsed = Date.now() - queuedShownAtRef.current
    const remaining = Math.max(0, QUEUED_MIN_VISIBLE_MS - elapsed)

    if (remaining === 0) {
      setShowQueued(false)
      queuedShownAtRef.current = null
      return
    }

    clearTimerRef.current = setTimeout(() => {
      setShowQueued(false)
      queuedShownAtRef.current = null
      clearTimerRef.current = null
    }, remaining)
  }, [isQueued])

  // Separate edit_request badges (rendered above bubble) from other badges (rendered inline)
  const editRequestBadges = badges?.filter(isEditRequestBadge) ?? []
  const inlineBadges = badges?.filter(b => !isEditRequestBadge(b)) ?? []
  const hasEditRequestBadges = editRequestBadges.length > 0
  const hasInlineBadges = inlineBadges.length > 0

  // Strip edit_request content from the displayed text
  // Each badge has start/end positions marking where to remove content
  let displayContent = content
  if (hasEditRequestBadges) {
    // Sort badges by start position descending so we can remove from end to start
    // (this preserves positions for earlier removals)
    const sortedBadges = [...editRequestBadges].sort((a, b) => b.start - a.start)
    for (const badge of sortedBadges) {
      displayContent = displayContent.slice(0, badge.start) + displayContent.slice(badge.end)
    }
    displayContent = displayContent.trim()
  }

  return (
    <div className={cn("flex flex-col items-end gap-3 w-full", className)}>
      {/* Attachment preview row - stored attachments with thumbnails */}
      {hasAttachments && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {attachments!.map((att, i) => {
            const isImage = att.type === 'image'
            const hasThumbnail = !!att.thumbnailBase64

            return (
              <div
                key={att.id || i}
                className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => att.storedPath && onFileClick?.(att.storedPath)}
                title={t('chat.clickToOpen', { name: att.name })}
              >
                {isImage ? (
                  /* IMAGE: Square thumbnail only */
                  <div className="h-14 w-14 rounded-[10px] border border-border/50 overflow-hidden bg-background shadow-minimal">
                    {hasThumbnail ? (
                      <img
                        src={`data:image/png;base64,${att.thumbnailBase64}`}
                        alt={att.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                ) : (
                  /* DOCUMENT: Bubble with thumbnail/icon + 2-line text */
                  <div className="flex items-center gap-2.5 rounded-[10px] border border-border/50 bg-user-message-bubble pl-1.5 pr-3 py-1.5 shadow-minimal">
                    <div className="h-11 w-8 rounded-[6px] overflow-hidden bg-background shadow-minimal flex items-center justify-center shrink-0">
                      {hasThumbnail ? (
                        <img
                          src={`data:image/png;base64,${att.thumbnailBase64}`}
                          alt={att.name}
                          className="h-full w-full object-cover object-top"
                        />
                      ) : (
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-[120px]">
                      <span className="text-xs font-medium line-clamp-2 break-all" title={att.name}>
                        {att.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {getFileTypeLabel(att.type, att.mimeType, att.name)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Badges row - edit request badges above text bubble */}
      {hasEditRequestBadges && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {editRequestBadges.map((badge, i) => (
            <EditRequestBadge key={`edit-badge-${i}`} badge={badge} />
          ))}
        </div>
      )}

      {/* Text content bubble. Queued messages render an inline header chip
          inside the bubble (Clock icon + 'Queued' italic) instead of a
          separate pill below — keeps the chat to one bubble per message
          while the chip and pulsing icon make the waiting state obvious
          (#616 follow-up). */}
      <div
        className={cn(
          "max-w-[80%] bg-user-message-bubble rounded-2xl border border-foreground/[0.04] shadow-xs break-words min-w-0 select-text [&_p]:m-0",
          compactMode ? "px-4 py-2" : "px-5 py-3"
        )}
      >
        {showQueued && (
          <div
            className="flex items-center gap-1.5 text-foreground/55 mb-1.5"
            role="status"
            aria-live="polite"
          >
            <Clock className="h-3 w-3 animate-pulse" aria-hidden="true" />
            <span className="text-[11px] italic">{t('chat.queuedBadge')}</span>
          </div>
        )}
        {hasInlineBadges
          ? renderContentWithBadges(displayContent, inlineBadges, onUrlClick, onFileClick)
          : (
            <Markdown
              mode="minimal"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
              className="text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap"
            >
              {displayContent}
            </Markdown>
          )
        }
      </div>
    </div>
  )
}
