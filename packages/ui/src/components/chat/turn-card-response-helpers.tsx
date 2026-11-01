

import { useTranslation } from 'react-i18next';
import type { AnnotationV1 } from '@craft-agent/core';

import { GitBranch } from 'lucide-react';
import { cn } from '../../lib/utils';

import { collectTextSegments, getCanonicalText } from '../annotations/annotation-core';
import { annotationColorToCss } from '../annotations/annotation-style-tokens';

import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem } from '../ui/StyledDropdown';
import { SIZE_CONFIG, type AnnotationInteractionMode, type OpenAnnotationRequest } from "./turn-card-contracts";

export interface ResponseCardProps {
  /** The content to display (markdown) */
  text: string
  /** Whether the content is still streaming */
  isStreaming: boolean
  /** When streaming started - used for buffering timeout calculation */
  streamStartTime?: number | undefined
  /** Callback to open file in editor */
  onOpenFile?: ((path: string) => void) | undefined
  /** Callback to open URL */
  onOpenUrl?: ((url: string) => void) | undefined
  /** Callback to open response in Monaco editor */
  onPopOut?: (() => void) | undefined
  /** Card variant - 'response' for AI messages, 'plan' for plan messages */
  variant?: 'response' | 'plan' | undefined
  /** Optional presentation variant for ordinary assistant responses. Plans stay card-based. */
  presentation?: 'default' | 'codex' | undefined
  /** Parent session ID (used to reset local annotation/island UI state on session switches) */
  sessionId?: string | undefined
  /** Underlying message ID for annotation actions */
  messageId?: string | undefined
  /** Persisted annotations for this response */
  annotations?: AnnotationV1[] | undefined
  /** Callback when user accepts the plan (plan variant only) */
  onAccept?: (() => void) | undefined
  /** Callback when user accepts the plan with compaction (compact first, then execute) */
  onAcceptWithCompact?: (() => void) | undefined
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean | undefined
  /** Whether to show the Accept Plan button (default: true) */
  showAcceptPlan?: boolean | undefined
  /** Compact-footer layout. Hides Copy / Markdown / Branch in the response footer;
   *  keeps the Accept Plan dropdown when a plan is the last response. */
  compactMode?: boolean | undefined
  /** Callback to branch the session from this response */
  onBranch?: ((options?: { newPanel?: boolean }) => void) | undefined
  /** Callback to add annotation from selected text */
  onAddAnnotation?: ((messageId: string, annotation: AnnotationV1) => void) | undefined
  /** Callback to remove persisted annotation */
  onRemoveAnnotation?: ((messageId: string, annotationId: string) => void) | undefined
  /** Callback to update persisted annotation */
  onUpdateAnnotation?: ((messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void) | undefined
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter' | undefined
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: ((target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void) | undefined
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean | undefined
  /** External request to open a specific annotation in this response */
  openAnnotationRequest?: OpenAnnotationRequest | null | undefined
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode | undefined
}

export interface BranchDropdownProps {
  onBranch: (options?: { newPanel?: boolean }) => void
}

export function BranchDropdown({ onBranch }: BranchDropdownProps) {
  const { t } = useTranslation()
  const handleBranchClick = () => {
    onBranch({ newPanel: true })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.branchOptions')}
          title={t('chat.branch')}
          className={cn(
            "p-1 rounded-[4px] transition-colors select-none",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            "data-[state=open]:text-foreground data-[state=open]:bg-foreground/5",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          <GitBranch className={SIZE_CONFIG.iconSize} />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" minWidth="min-w-64" sideOffset={6}>
        <StyledDropdownMenuItem onClick={handleBranchClick} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{t('chat.branchFromThisMessage')}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('chat.branchFromThisMessageDescription')}
            </span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

export const MAX_HEIGHT = 540

export function clearAnnotationMarks(root: HTMLElement): void {
  const annotatedInlineCodeNodes = root.querySelectorAll<HTMLElement>('code[data-ca-annotation-inline-code="true"]')
  annotatedInlineCodeNodes.forEach((codeNode) => {
    codeNode.removeAttribute('data-ca-annotation-inline-code')
    codeNode.style.backgroundColor = ''
    codeNode.classList.remove('shadow-none')
  })

  const marks = root.querySelectorAll('span[data-ca-annotation-id]')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (!parent) return

    const badge = mark.querySelector('[data-ca-annotation-index]')
    if (badge) badge.remove()

    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
    parent.normalize()
  })
}

export function createAnnotationIndexBadge(index: number): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.setAttribute('data-ca-annotation-index', String(index))
  chip.textContent = String(index)
  chip.style.position = 'absolute'
  chip.style.top = '-7px'
  chip.style.right = '-7px'
  chip.style.minWidth = '16px'
  chip.style.height = '15px'
  chip.style.padding = '0 3px'
  chip.style.borderRadius = '9999px'
  chip.style.backgroundColor = 'var(--info)'
  chip.style.color = 'rgba(15, 23, 42, 0.95)'
  chip.style.fontSize = '10px'
  chip.style.fontWeight = '600'
  chip.style.lineHeight = '15px'
  chip.style.textAlign = 'center'
  chip.classList.add('shadow-tinted')
  chip.style.setProperty('--shadow-color', 'var(--info-rgb)')
  chip.style.pointerEvents = 'none'
  chip.style.userSelect = 'none'
  return chip
}

export function applyTextHighlightRange(
  root: HTMLElement,
  range: { start: number; end: number },
  annotation: AnnotationV1,
  annotationIndex?: number,
): void {
  if (range.end <= range.start) return

  // Avoid visually highlighting trailing/leading hard newlines.
  // Those can produce extra apparent blank lines at line boundaries.
  const fullText = getCanonicalText(root)
  let displayStart = range.start
  let displayEnd = range.end
  while (displayStart < displayEnd && /[\n\r]/.test(fullText[displayStart] ?? '')) displayStart += 1
  while (displayEnd > displayStart && /[\n\r]/.test(fullText[displayEnd - 1] ?? '')) displayEnd -= 1
  if (displayEnd <= displayStart) return

  const segments = collectTextSegments(root)
  const createdMarks: HTMLSpanElement[] = []

  for (const segment of segments) {
    if (segment.end <= displayStart || segment.start >= displayEnd) continue

    const localStart = Math.max(displayStart, segment.start) - segment.start
    const localEnd = Math.min(displayEnd, segment.end) - segment.start
    if (localEnd <= localStart) continue

    const source = segment.node
    const after = source.splitText(localEnd)
    const selected = source.splitText(localStart)

    const inlineCodeParent = selected.parentElement?.closest<HTMLElement>('code')
    if (inlineCodeParent) {
      inlineCodeParent.setAttribute('data-ca-annotation-inline-code', 'true')
      inlineCodeParent.style.backgroundColor = annotationColorToCss(annotation.style?.color)
      inlineCodeParent.classList.add('shadow-none')
    }

    const mark = document.createElement('span')
    mark.setAttribute('data-ca-annotation-id', annotation.id)
    mark.style.backgroundColor = annotationColorToCss(annotation.style?.color)
    mark.style.borderRadius = '0'
    mark.style.padding = '0'
    mark.style.margin = '0'
    mark.style.position = 'relative'
    selected.parentNode?.replaceChild(mark, selected)
    mark.appendChild(selected)
    createdMarks.push(mark)

    // Keep reference alive for TS and clarity
    void after
  }

  if (createdMarks.length > 0) {
    type RowBucket = { top: number; marks: HTMLSpanElement[] }
    const rows: RowBucket[] = []

    for (const mark of createdMarks) {
      const rect = mark.getBoundingClientRect()
      const row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= 2)
      if (row) {
        row.marks.push(mark)
      } else {
        rows.push({ top: rect.top, marks: [mark] })
      }
    }

    for (const row of rows) {
      const rowMarks = row.marks
      const first = rowMarks[0]
      const last = rowMarks[rowMarks.length - 1]
      if (!first || !last) continue

      first.style.borderTopLeftRadius = '6px'
      first.style.borderBottomLeftRadius = '6px'
      last.style.borderTopRightRadius = '6px'
      last.style.borderBottomRightRadius = '6px'
    }
  }

  if (annotationIndex != null && createdMarks.length > 0) {
    // Prefer placing the index badge on non-code marks, then choose the top-right-most
    // mark on the first visible row for stable placement.
    const nonCodeMarks = createdMarks.filter(mark => !mark.closest('code'))
    const badgePool = nonCodeMarks.length > 0 ? nonCodeMarks : createdMarks

    const preferredInitial = badgePool[0]
    if (!preferredInitial) return

    let preferredMark = preferredInitial
    let preferredRect = preferredMark.getBoundingClientRect()

    for (const mark of badgePool.slice(1)) {
      const rect = mark.getBoundingClientRect()
      const isHigherRow = rect.top < preferredRect.top - 1
      const sameRow = Math.abs(rect.top - preferredRect.top) <= 2
      const isMoreRight = rect.right > preferredRect.right

      if (isHigherRow || (sameRow && isMoreRight)) {
        preferredMark = mark
        preferredRect = rect
      }
    }

    preferredMark.appendChild(createAnnotationIndexBadge(annotationIndex))
  }
}
