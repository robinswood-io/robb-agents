import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { coerceInputText } from '@/lib/input-text';
import { cn } from '@/lib/utils';
import { parseMentions } from '@/lib/mentions';
import { loadSourceIcon, loadSkillIcon } from '@/lib/icon-cache';

import { textToHTML, getMentionSignature } from "./rich-text-html";
import { isEscapeDuringComposition, getTextFromElement, getCursorPosition, setCursorPosition } from "./rich-text-dom";
export { type EscapeCompositionEventLike, isEscapeDuringComposition } from "./rich-text-dom";






import type { LoadedSkill, LoadedSource } from '../../../shared/types';


// ============================================================================
// Types
// ============================================================================

/** Line count threshold for auto-converting pasted text to file attachment */
const LONG_TEXT_LINE_THRESHOLD = 100

export interface RichTextInputProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onInput' | 'onPaste'> {
  /** Current text value */
  value: string
  /** Called when text changes */
  onChange: (value: string) => void
  /** Placeholder text(s) when empty - can be a single string or array for rotation */
  placeholder?: string | string[]
  /** Available skills for mention parsing */
  skills?: LoadedSkill[]
  /** Available sources for mention parsing */
  sources?: LoadedSource[]
  /** Workspace ID for avatars */
  workspaceId?: string
  /** Whether the input is disabled */
  disabled?: boolean
  /** Called when input changes (provides value and cursor position for mention detection) */
  onInput?: (value: string, cursorPosition: number) => void
  /** Called on paste */
  onPaste?: (e: React.ClipboardEvent) => void
  /** Called when pasted text exceeds line threshold - should create file attachment */
  onLongTextPaste?: (text: string) => void
}

export interface RichTextInputHandle {
  focus: () => void
  blur: () => void
  /** The text value */
  value: string
  /** Selection start position in text model */
  selectionStart: number
  /** Set the text value */
  setValue: (value: string) => void
  /** Set selection range */
  setSelectionRange: (start: number, end: number) => void
  /** Get bounding rect for position calculations */
  getBoundingClientRect: () => DOMRect
  /** Get bounding rect of the current caret/selection position */
  getCaretRect: () => DOMRect | null
  /** The underlying div element */
  element: HTMLDivElement | null
}

// ============================================================================
// RotatingPlaceholder Component
// Animated placeholder that cycles through an array of strings with fade transitions.
// Stays visible even when input is focused (until user types).
// ============================================================================

interface RotatingPlaceholderProps {
  /** Array of placeholder strings to rotate through */
  placeholders: string[]
  /** Interval in ms between rotations (default: 5000) */
  intervalMs?: number
  /** Additional className for styling */
  className?: string
}

function RotatingPlaceholder({
  placeholders,
  intervalMs = 5000,
  className,
}: RotatingPlaceholderProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0)
  const [opacity, setOpacity] = React.useState(1)

  React.useEffect(() => {
    // Don't rotate if only one placeholder
    if (placeholders.length <= 1) return

    const interval = setInterval(() => {
      // Fade out
      setOpacity(0)

      // After fade out (300ms), swap text and fade back in
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % placeholders.length)
        setOpacity(1)
      }, 300)
    }, intervalMs)

    return () => clearInterval(interval)
  }, [placeholders.length, intervalMs])

  return (
    <div
      data-rich-text-placeholder="true"
      className={cn('transition-opacity duration-300 ease-in-out', className)}
      style={{ opacity }}
    >
      {placeholders[currentIndex]}
    </div>
  )
}

// ============================================================================
// RichTextInput Component
// ============================================================================

export const RichTextInput = React.forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    {
      value,
      onChange,
      placeholder,
      skills = [],
      sources = [],
      workspaceId,
      disabled = false,
      className,
      onFocus,
      onBlur,
      onKeyDown,
      onInput,
      onPaste,
      onLongTextPaste,
      ...restProps
    },
    forwardedRef
  ) {
    const { t } = useTranslation()
    const safeValue = React.useMemo(() => coerceInputText(value), [value])
    const divRef = React.useRef<HTMLDivElement>(null)
    const [isFocused, setIsFocused] = React.useState(false)
    const isComposing = React.useRef(false)
    const lastValueRef = React.useRef(safeValue)
    const cursorPositionRef = React.useRef(0)
    const lastMentionSignatureRef = React.useRef('')
    const isInternalUpdate = React.useRef(false)
    // Pending cursor position to restore after external value update (e.g., after @mention selection)
    const pendingCursorRef = React.useRef<number | null>(null)

    const skillSlugs = React.useMemo(() => skills.map(s => s.slug), [skills])
    const sourceSlugs = React.useMemo(() => sources.map(s => s.config.slug), [sources])

    // Icons are optional: preload sequentially so new messages keep RPC capacity.
    React.useEffect(() => {
      if (!workspaceId) return
      let cancelled = false

      async function preloadIcons() {
        for (const source of sources) {
          if (cancelled) return
          await loadSourceIcon({ config: source.config, workspaceId: workspaceId! })
        }
        for (const skill of skills) {
          if (cancelled) return
          await loadSkillIcon(skill, workspaceId!)
        }
      }
      void preloadIcons()
      return () => { cancelled = true }
    }, [sources, skills, workspaceId])

    // Expose imperative handle
    React.useImperativeHandle(forwardedRef, () => ({
      focus: () => divRef.current?.focus(),
      blur: () => divRef.current?.blur(),
      get value() { return lastValueRef.current },
      get selectionStart() { return cursorPositionRef.current },
      setValue: (newValue: string) => {
        lastValueRef.current = newValue
      },
      setSelectionRange: (start: number, _end: number) => {
        // Store pending cursor for when external value sync runs
        pendingCursorRef.current = start
        cursorPositionRef.current = start
        if (divRef.current) {
          setCursorPosition(divRef.current, start)
        }
      },
      getBoundingClientRect: () => divRef.current?.getBoundingClientRect() ?? new DOMRect(),
      getCaretRect: () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return null
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        // If rect has zero dimensions (collapsed selection at line start), use a fallback
        if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) {
          // Insert a temporary span to measure position
          const span = document.createElement('span')
          span.textContent = '\u200B' // Zero-width space
          range.insertNode(span)
          const spanRect = span.getBoundingClientRect()
          span.remove()
          // Restore selection
          selection.removeAllRanges()
          selection.addRange(range)
          return spanRect
        }
        return rect
      },
      get element() { return divRef.current },
    }), [])

    // Handle input events
    const handleInput = React.useCallback(() => {
      if (isComposing.current) return
      if (!divRef.current) return

      const newText = getTextFromElement(divRef.current)
      const cursorPos = getCursorPosition(divRef.current, cursorPositionRef.current)

      lastValueRef.current = newText
      cursorPositionRef.current = cursorPos

      // Check if mentions changed - if so, we need to re-render HTML
      const newSignature = getMentionSignature(newText, skillSlugs, sourceSlugs)
      if (newSignature !== lastMentionSignatureRef.current) {
        lastMentionSignatureRef.current = newSignature
        // Re-render with badges
        isInternalUpdate.current = true
        const html = textToHTML(newText, skills, sources, workspaceId)
        divRef.current.innerHTML = html || '<br>' // Empty contenteditable needs a BR
        // Restore cursor
        setCursorPosition(divRef.current, cursorPos)
        isInternalUpdate.current = false
      }

      onChange(newText)
      onInput?.(newText, cursorPos)
    }, [onChange, onInput, skills, sources, skillSlugs, sourceSlugs, workspaceId])

    // Handle composition (IME)
    const handleCompositionStart = React.useCallback(() => {
      isComposing.current = true
    }, [])

    const handleCompositionEnd = React.useCallback(() => {
      isComposing.current = false
      handleInput()
    }, [handleInput])

    const handleKeyDownInternal = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEscapeDuringComposition(e, isComposing.current)) {
        e.stopPropagation()
        return
      }

      onKeyDown?.(e)
    }, [onKeyDown])

    // Handle paste - delegate files to parent, manually insert plain text
    const handlePasteInternal = React.useCallback((e: React.ClipboardEvent) => {
      // Check if we have files - let parent handle that
      const hasFiles = e.clipboardData?.files && e.clipboardData.files.length > 0
      if (hasFiles && onPaste) {
        e.preventDefault()
        onPaste(e)
        return
      }

      // Prevent default to avoid HTML paste, then insert plain text manually
      e.preventDefault()

      const text = e.clipboardData?.getData('text/plain')
      if (!text) return

      // Check if text is too long - convert to file attachment instead
      const lineCount = text.split('\n').length
      if (lineCount > LONG_TEXT_LINE_THRESHOLD && onLongTextPaste) {
        onLongTextPaste(text)
        return
      }

      // Use execCommand to insert text - this integrates with the browser's
      // native undo stack so CMD+Z works after paste. Manual DOM manipulation
      // (range.insertNode) bypasses the undo history.
      document.execCommand('insertText', false, text)
    }, [onPaste, onLongTextPaste])

    // Handle focus
    const handleFocus = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(true)
      // Tell browser to use <br> instead of <div> for line breaks.
      // This prevents div-wrapping when typing before non-editable spans (badges).
      document.execCommand('defaultParagraphSeparator', false, 'br')
      onFocus?.(e)
    }, [onFocus])

    // Handle blur
    const handleBlur = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
      setIsFocused(false)
      onBlur?.(e)
    }, [onBlur])

    // Sync value from props (when parent updates value externally)
    React.useEffect(() => {
      if (!divRef.current) return
      if (isInternalUpdate.current) return
      if (lastValueRef.current === safeValue) return

      // External value change - update content
      lastValueRef.current = safeValue
      lastMentionSignatureRef.current = getMentionSignature(safeValue, skillSlugs, sourceSlugs)

      const html = textToHTML(safeValue, skills, sources, workspaceId)
      divRef.current.innerHTML = html || '<br>'

      // Restore cursor position after innerHTML update.
      // Only restore if:
      // 1. We have a pending position from setSelectionRange (explicit programmatic positioning), OR
      // 2. The element is actually focused (user is actively editing)
      // This prevents stealing focus during session changes when search is active.
      if (pendingCursorRef.current !== null || document.activeElement === divRef.current) {
        const cursorPos = pendingCursorRef.current ?? cursorPositionRef.current ?? safeValue.length
        setCursorPosition(divRef.current, cursorPos)
        pendingCursorRef.current = null // Clear after use
      }
    }, [safeValue, skills, sources, skillSlugs, sourceSlugs, workspaceId])

    // Initialize content on mount
    React.useEffect(() => {
      if (!divRef.current) return
      lastMentionSignatureRef.current = getMentionSignature(safeValue, skillSlugs, sourceSlugs)
      const html = textToHTML(safeValue, skills, sources, workspaceId)
      divRef.current.innerHTML = html || '<br>'
      lastValueRef.current = safeValue
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // Handle selection changes to highlight badges when selected
    React.useEffect(() => {
      // Get selection color from CSS variable (accent with transparency)
      const getSelectionColor = () => {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
        // Return accent color with 40% opacity
        return accent ? `oklch(${accent.replace('oklch(', '').replace(')', '')} / 0.4)` : 'rgba(99, 102, 241, 0.4)'
      }

      const handleSelectionChange = () => {
        if (!divRef.current) return

        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return

        const range = selection.getRangeAt(0)

        // Get all mention badges
        const badges = divRef.current.querySelectorAll('.mention-badge') as NodeListOf<HTMLElement>

        badges.forEach((badge) => {
          // Check if badge is within selection range
          const badgeRange = document.createRange()
          badgeRange.selectNode(badge)

          const isSelected =
            range.compareBoundaryPoints(Range.START_TO_END, badgeRange) > 0 &&
            range.compareBoundaryPoints(Range.END_TO_START, badgeRange) < 0

          if (isSelected) {
            badge.style.backgroundColor = getSelectionColor()
            badge.classList.remove('bg-background')
          } else {
            badge.style.backgroundColor = ''
            badge.classList.add('bg-background')
          }
        })
      }

      document.addEventListener('selectionchange', handleSelectionChange)
      return () => document.removeEventListener('selectionchange', handleSelectionChange)
    }, [])

    // Show placeholder when input is empty (regardless of focus state)
    const showPlaceholder = !safeValue

    // Normalize placeholder to array for RotatingPlaceholder
    const placeholderArray = React.useMemo(() => {
      if (!placeholder) return [t("chatInput.placeholder.typeMessage")]
      return Array.isArray(placeholder) ? placeholder : [placeholder]
    }, [placeholder, t])

    // Check if value contains any mentions (badges) to adjust line height
    const hasMentions = React.useMemo(() => {
      const mentions = parseMentions(safeValue, skillSlugs, sourceSlugs)
      return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0
    }, [safeValue, skillSlugs, sourceSlugs])

    return (
      <div className="relative">
        <div
          ref={divRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          tabIndex={disabled ? -1 : 0}
          className={cn(
            'outline-none text-sm whitespace-pre-wrap break-words',
            'min-h-[1.5em]',
            disabled && 'opacity-50 cursor-not-allowed',
            // Make text transparent when showing placeholder (so caret is still visible)
            showPlaceholder && 'text-transparent caret-foreground',
            className
          )}
          // Use inline style for line-height to override text-sm's built-in line-height
          style={{ lineHeight: 1.25 }}
          onInput={handleInput}
          onKeyDown={handleKeyDownInternal}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPaste={handlePasteInternal}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          aria-disabled={disabled}
          aria-placeholder={Array.isArray(placeholder) ? placeholder[0] : placeholder}
          role="textbox"
          aria-multiline="true"
          {...restProps}
        />
        {/* Rotating placeholder overlay - visible when empty, even when focused */}
        {showPlaceholder && (
          <RotatingPlaceholder
            placeholders={placeholderArray}
            intervalMs={5000}
            className={cn(
              'absolute inset-0 text-sm text-muted-foreground pointer-events-none select-none',
              className
            )}
          />
        )}
      </div>
    )
  }
)
