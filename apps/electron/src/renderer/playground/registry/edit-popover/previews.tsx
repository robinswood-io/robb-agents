import * as React from "react";
import { useState, useCallback, useEffect, useRef } from "react";
import type { Message } from "@craft-agent/core/types";
import { ChatDisplay } from "../../../components/app-shell/ChatDisplay";
import { EditPopover } from "../../../components/ui/EditPopover";
import { FocusProvider } from "../../../context/FocusContext";
import { EscapeInterruptProvider } from "../../../context/EscapeInterruptContext";
import { AppShellProvider } from "../../../context/AppShellContext";
import { GripHorizontal, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { completedMessages, createSession, mockAppShellContext, sampleEditContext } from "./fixtures";

// ============================================================================
// Compact ChatDisplay Preview Wrapper
// ============================================================================

interface CompactChatPreviewProps {
  messages: Message[]
  isProcessing?: boolean
  placeholder?: string
}

/**
 * Wrapper that renders ChatDisplay in compact mode with a popover-like container
 * to simulate how it appears in the EditPopover.
 */
export function CompactChatPreview({
  messages = completedMessages,
  isProcessing = false,
  placeholder = "Describe what you'd like to change...",
}: CompactChatPreviewProps) {
  const [model, setModel] = useState('haiku')
  const session = createSession(messages, isProcessing)

  // Drag state for movable preview
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })

  // Resize state
  const [size, setSize] = useState({ width: 400, height: 400 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

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
      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y
      setDragOffset({
        x: dragStartRef.current.offsetX + deltaX,
        y: dragStartRef.current.offsetY + deltaY,
      })
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
      width: size.width,
      height: size.height,
    }
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setSize({
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

  const handleSendMessage = (message: string) => {
    console.log('[Playground] Send message:', message)
  }

  const handleOpenFile = (path: string) => {
    console.log('[Playground] Open file:', path)
  }

  const handleOpenUrl = (url: string) => {
    console.log('[Playground] Open URL:', url)
  }

  return (
    <FocusProvider>
      <EscapeInterruptProvider>
        <div
          className="popover-styled p-0 overflow-hidden relative"
          style={{
            width: size.width,
            height: size.height,
            borderRadius: 16,
            transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
          }}
        >
          {/* Drag handle - 4px lower with asymmetric padding */}
          <div
            onMouseDown={handleDragStart}
            className={cn(
              "flex items-center justify-center pt-2.5 pb-1.5 border-b border-border/30 cursor-grab",
              isDragging && "cursor-grabbing"
            )}
          >
            <GripHorizontal className="w-4 h-4 text-muted-foreground/50" />
          </div>

          {/* Content - compact ChatDisplay */}
          <div className="flex-1 flex flex-col" style={{ height: 'calc(100% - 34px)' }}>
            <ChatDisplay
              session={session}
              onSendMessage={handleSendMessage}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              currentModel={model}
              onModelChange={(nextModel) => {
                if (nextModel !== null) setModel(nextModel)
              }}
              compactMode={true}
              placeholder={placeholder}
            />
          </div>

          {/* Bottom-right resize handle - invisible hit area */}
          <div
            onMouseDown={handleResizeStart}
            className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize"
          />
        </div>
      </EscapeInterruptProvider>
    </FocusProvider>
  )
}

interface EditPopoverPreviewProps {
  inlineExecution?: boolean
  example?: string
  triggerLabel?: string
}

/**
 * Wrapper that renders the actual EditPopover component with a trigger button
 */
export function EditPopoverPreview({
  inlineExecution = true,
  example = 'Add a "Bug" label with red color',
  triggerLabel = "Edit",
}: EditPopoverPreviewProps) {
  return (
    <AppShellProvider value={mockAppShellContext}>
      <FocusProvider>
        <EscapeInterruptProvider>
          <div className="flex flex-col items-center gap-4">
            <EditPopover
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil className="w-4 h-4 mr-2" />
                  {triggerLabel}
                </Button>
              }
              context={sampleEditContext}
              example={example}
              inlineExecution={inlineExecution}
            />
            <p className="text-xs text-muted-foreground">Click the button to open the popover</p>
          </div>
        </EscapeInterruptProvider>
      </FocusProvider>
    </AppShellProvider>
  )
}
