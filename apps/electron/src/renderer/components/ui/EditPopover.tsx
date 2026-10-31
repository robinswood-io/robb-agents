/**
 * EditPopover
 *
 * A popover with title, subtitle, and multiline textarea for editing settings.
 * Supports two modes:
 * - Legacy: Opens a new focused window with a chat session
 * - Inline: Executes mini agent inline within the popover using compact ChatDisplay
 */

import * as React from 'react';
import { useState,useRef,useEffect,useCallback,useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import "i18next";
import { GripHorizontal } from 'lucide-react';
import { motion,AnimatePresence } from 'motion/react';
import { Popover,PopoverTrigger,PopoverContent } from './popover';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { usePlatform } from '@craft-agent/ui';
import { useActiveWorkspace,useAppShellContext,useSession,usePendingPermission,usePendingCredential } from '@/context/AppShellContext';
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext';
import { ChatDisplay } from '../app-shell/ChatDisplay';

import { COMPACT_PLACEHOLDER_KEYS } from "./edit-configs";
import { type EditContext,type EditPopoverProps,type EditPromptResult } from "./edit-popover-types";
export { getEditConfig } from "./edit-configs";
export { type EditContext, type EditContextKey, type EditConfig, type SecondaryAction, type EditPopoverProps } from "./edit-popover-types";





 // motion used for backdrop only
 // motion used for backdrop only
 // motion used for backdrop only
// motion used for backdrop only




import type { ContentBadge,Session,CreateSessionOptions } from '../../../shared/types';




/**
 * Build the prompt that will be sent to the agent.
 * Uses XML-like tags for clear structure.
 *
 * Returns both the prompt and a context badge that marks the metadata section
 * so it can be hidden in the UI while still being sent to the agent.
 *
 * @param context - The edit context with label, filePath, and optional context
 * @param userInstructions - User's instructions (can be empty string for pre-filled context only)
 *
 * @example
 * // With user instructions (for EditPopover submit)
 * const { prompt, badges } = buildEditPrompt(context, "Add a Blocked status")
 *
 * // Without user instructions (for context menu - opens window with context pre-filled)
 * const { prompt, badges } = buildEditPrompt(context, "")
 */
export function buildEditPrompt(context: EditContext, userInstructions: string, displayLabel?: string): EditPromptResult {
  // Build the metadata section (will be hidden by badge)
  // Simple structure: label (for display/context), file (where to edit), optional context
  // context.label stays in English for the agent; displayLabel is translated for UI
  const metadataSection = `<edit_request>
<label>${context.label}</label>
<file>${context.filePath}</file>
${context.context ? `<context>${context.context}</context>\n` : ''}</edit_request>

`

  // Badge display: use translated displayLabel if available, else English label
  const collapsedLabel = displayLabel || context.label

  // Full prompt = metadata + user instructions
  const prompt = metadataSection + userInstructions

  // Create badge marking the metadata section (start=0, end=metadata length)
  const badge: ContentBadge = {
    type: 'context',
    label: collapsedLabel,
    rawText: metadataSection,
    start: 0,
    end: metadataSection.length,
    collapsedLabel,
  }

  return { prompt, badges: [badge] }
}

export function EditPopover({
  trigger,
  example,
  context,
  permissionMode = 'allow-all',
  workingDirectory = 'none', // Default to session folder for config edits
  model,
  systemPromptPreset,
  width = 400, // Default 400px for compact chat embedding
  triggerClassName,
  side = 'bottom',
  align = 'end',
  overridePlaceholder,
  displayLabel,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  modal = false,
  inlineExecution = false,
}: EditPopoverProps) {
  const { t } = useTranslation()
  const { onOpenFile, onOpenUrl } = usePlatform()
  const workspace = useActiveWorkspace()

  // Build placeholder: for inline execution use rotating array, otherwise build descriptive string
  // overridePlaceholder allows contexts like add-source/add-skill to say "add" instead of "change"
  const placeholder = inlineExecution
    ? COMPACT_PLACEHOLDER_KEYS.map(key => t(key))
    : (() => {
        const basePlaceholder = overridePlaceholder ?? t("editPopover.describePlaceholder")
        return example
          ? `${basePlaceholder.replace(/\.{3}$/, '')}, e.g., "${example}"`
          : basePlaceholder
      })()

  // Support both controlled and uncontrolled modes:
  // - Uncontrolled (default): internal state manages open/close
  // - Controlled: parent manages state via open/onOpenChange props
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = useCallback((value: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(value)
    } else {
      setInternalOpen(value)
    }
  }, [isControlled, controlledOnOpenChange])

  // Use App context for session management (same code path as main chat)
  const { onCreateSession, onSendMessage, onRespondToPermission, onRespondToCredential } = useAppShellContext()

  // Session ID for inline execution (created on first message)
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)

  // Get session data from Jotai atom (same as main chat - includes optimistic updates)
  // Pass empty string when no session yet - atom returns null for unknown IDs
  const inlineSession = useSession(inlineSessionId || '')

  // Pending permission/credential requests for inline session (same flow as main chat)
  const pendingPermission = usePendingPermission(inlineSessionId || '')
  const pendingCredential = usePendingCredential(inlineSessionId || '')

  // Model state for ChatDisplay (starts with prop value, can be changed by user)
  const [currentModel, setCurrentModel] = useState(model ?? '')

  // Create a stub session for ChatDisplay when no real session exists yet
  // This allows showing the input before the first message is sent
  const stubSession = useMemo((): Session => ({
    id: 'pending',
    workspaceId: workspace?.id || '',
    workspaceName: workspace?.name || '',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }), [workspace?.id, workspace?.name])

  // Use real session if available, otherwise stub
  const displaySession = inlineSession || stubSession

  // Track processing state for close prevention and backdrop
  const isProcessing = displaySession.isProcessing

  // Use existing escape interrupt context for double-ESC flow
  // This shows the "Press Esc again to interrupt" overlay in the input field
  const { handleEscapePress } = useEscapeInterrupt()

  // Reset inline session when popover closes
  const resetInlineSession = useCallback(() => {
    setInlineSessionId(null)
  }, [])

  // Stop/cancel generation for the inline session
  const handleStopGeneration = useCallback(() => {
    if (inlineSessionId && isProcessing) {
      window.electronAPI.cancelProcessing(inlineSessionId, false)
    }
  }, [inlineSessionId, isProcessing])

  // Handle ESC key during generation:
  // Uses EscapeInterruptContext for double-ESC flow (shows overlay, then interrupts)
  const handleEscapeKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isProcessing) {
      // Not processing - allow normal close behavior
      return
    }

    // Prevent default close behavior during processing
    e.preventDefault()

    // Use context's double-ESC handler
    // Returns true if this is the second press (should interrupt)
    const shouldInterrupt = handleEscapePress()
    if (shouldInterrupt) {
      handleStopGeneration()
    }
  }, [isProcessing, handleEscapePress, handleStopGeneration])

  // Handle click outside during generation:
  // Show the ESC overlay via context, prevent closing
  const handleInteractOutside = useCallback((e: Event) => {
    if (isProcessing) {
      // Prevent close during processing
      e.preventDefault()
      // Show the ESC overlay so user knows how to cancel
      handleEscapePress()
    }
  }, [isProcessing, handleEscapePress])

  // Drag state for movable popover
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const popoverRef = useRef<HTMLDivElement>(null)

  // Resize state for dynamic sizing
  const [containerSize, setContainerSize] = useState({ width: width || 400, height: 480 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Reset drag position and size when popover opens
  useEffect(() => {
    if (open) {
      dragOffsetRef.current = { x: 0, y: 0 }
      setDragOffset({ x: 0, y: 0 })
      setContainerSize({ width: width || 400, height: 480 })
    }
  }, [open, width])

  // Handle drag events
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    }
  }, [dragOffset])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const rect = popoverRef.current?.getBoundingClientRect()
      if (!rect) return

      const MARGIN = 20
      const MARGIN_TOP = 50 // Keep below header (chevrons, menu button)
      const curr = dragOffsetRef.current
      const baseX = rect.left - curr.x
      const baseY = rect.top - curr.y

      const newX = dragStartRef.current.offsetX + e.clientX - dragStartRef.current.x
      const newY = dragStartRef.current.offsetY + e.clientY - dragStartRef.current.y

      const clampedX = Math.max(MARGIN - baseX, Math.min(window.innerWidth - MARGIN - rect.width - baseX, newX))
      const clampedY = Math.max(MARGIN_TOP - baseY, Math.min(window.innerHeight - MARGIN - rect.height - baseY, newY))

      dragOffsetRef.current = { x: clampedX, y: clampedY }
      setDragOffset({ x: clampedX, y: clampedY })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: containerSize.width,
      height: containerSize.height,
    }
  }, [containerSize])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setContainerSize({
        width: Math.max(300, resizeStartRef.current.width + deltaX),
        height: Math.max(250, resizeStartRef.current.height + deltaY),
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Reset state when popover opens
  useEffect(() => {
    if (open) {
      setCurrentModel(model ?? '')
      resetInlineSession()
    }
  }, [open, model, resetInlineSession])

  // Handle sending message from ChatDisplay (inline mode)
  // Creates hidden session on first message, then uses App context for sending
  const handleInlineSendMessage = useCallback(async (message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)

    // Create session on first message
    let sessionId = inlineSessionId
    if (!sessionId && workspace?.id) {
      const createOptions: CreateSessionOptions = {
        ...(model !== undefined ? { model: model } : {}),
        systemPromptPreset: systemPromptPreset || 'mini',
        permissionMode,
        workingDirectory,
        hidden: true, // Hidden sessions use same App code path but don't appear in list
      }
      const newSession = await onCreateSession(workspace.id, createOptions)
      sessionId = newSession.id
      setInlineSessionId(sessionId)
      setCurrentModel(newSession.model ?? model ?? '')
    }

    // Send message via App context (includes optimistic user message update)
    // Pass badges to hide the <edit_request> XML metadata in the user message bubble
    if (sessionId) {
      onSendMessage(sessionId, prompt, undefined, undefined, badges)
    }
  }, [context, displayLabel, inlineSessionId, workspace?.id, model, systemPromptPreset, permissionMode, workingDirectory, onCreateSession, onSendMessage])

  // Legacy mode: navigates to chat in the same window
  const handleLegacySendMessage = useCallback((message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)
    const encodedInput = encodeURIComponent(prompt)
    const encodedBadges = encodeURIComponent(JSON.stringify(badges))

    const workdirParam = workingDirectory ? `&workdir=${encodeURIComponent(workingDirectory)}` : ''
    const modelParam = model ? `&model=${encodeURIComponent(model)}` : ''
    const systemPromptParam = systemPromptPreset ? `&systemPrompt=${encodeURIComponent(systemPromptPreset)}` : ''
    // Navigate in same window by omitting window=focused parameter
    const url = `craftagents://action/new-session?input=${encodedInput}&send=true&mode=${permissionMode}&badges=${encodedBadges}${workdirParam}${modelParam}${systemPromptParam}`

    window.electronAPI.openUrl(url)
    setOpen(false)
  }, [context, displayLabel, workingDirectory, model, systemPromptPreset, permissionMode, setOpen])

  return (
    <>
      {/* Full-screen backdrop - rendered BEHIND the popover during processing */}
      <AnimatePresence>
        {open && isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="fixed inset-0 bg-black/5 z-40"
          />
        )}
      </AnimatePresence>

      <Popover open={open} onOpenChange={setOpen} modal={modal}>
        <PopoverTrigger asChild className={triggerClassName}>
          {trigger}
        </PopoverTrigger>
        <PopoverContent
            side={side}
            align={align}
            sticky="always"
            className="p-0"
            style={{
              width: containerSize.width,
              height: containerSize.height,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
            }}
            onInteractOutside={handleInteractOutside}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            {/* Container */}
            <div
              ref={popoverRef}
              className="relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small"
              style={{
                transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
                borderRadius: 16,
              }}
            >
              {/* Drag handle - floating overlay */}
              <div
                onMouseDown={handleDragStart}
                className={cn(
                  "absolute top-0 left-1/2 -translate-x-1/2 z-50 px-4 py-2 cursor-grab rounded pointer-events-auto titlebar-no-drag",
                  isDragging && "cursor-grabbing"
                )}
              >
                <GripHorizontal className="w-4 h-4 text-muted-foreground/30" />
              </div>

              {/* Content area - always uses compact ChatDisplay */}
              <div className="flex-1 flex flex-col bg-foreground-2" style={{ height: '100%' }}>
                <ChatDisplay
                  session={displaySession}
                  onSendMessage={inlineExecution ? handleInlineSendMessage : handleLegacySendMessage}
                  onOpenFile={onOpenFile || (() => {})}
                  onOpenUrl={onOpenUrl || (() => {})}
                  currentModel={currentModel}
                  onModelChange={(model) => {
                    if (model !== null) setCurrentModel(model)
                  }}
                  pendingPermission={pendingPermission}
                  onRespondToPermission={onRespondToPermission}
                  pendingCredential={pendingCredential}
                  onRespondToCredential={onRespondToCredential}
                  compactMode={true}
                  placeholder={placeholder}
                  emptyStateLabel={displayLabel || context.label}
                />
              </div>
            </div>

            {/* Bottom-right resize handle - outside overflow-hidden container */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize pointer-events-auto z-50"
              style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
            />
          </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * Standard Edit button styled for use with EditPopover.
 * Use this as the trigger prop for consistent styling across the app.
 *
 * Uses forwardRef to properly work with Radix's asChild pattern,
 * which requires the child to accept ref and spread props.
 *
 * @example
 * <EditPopover
 *   trigger={<EditButton />}
 *   context={getEditContext('workspace-permissions', { workspacePath })}
 * />
 */
export const EditButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Button>
>(function EditButton({ className, ...props }, ref) {
  const { t } = useTranslation()
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      // Merge our base styles with any className from asChild props
      className={cn("h-8 px-3 rounded-[6px] bg-background shadow-minimal text-foreground/70 hover:text-foreground", className)}
      {...props}
    >
      {t("common.edit")}
    </Button>
  )
})
