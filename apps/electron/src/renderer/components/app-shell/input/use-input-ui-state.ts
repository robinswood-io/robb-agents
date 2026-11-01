import * as React from 'react';

import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import { coerceInputText } from '@/lib/input-text';

import { useEscapeInterrupt } from '@/context/EscapeInterruptContext';

import { shouldHandleScopedInputEvent } from './input-event-guards';
import { readUsableViewportHeight,subscribeToViewportHeight } from './viewport-height';

import { useModelVisionToggle } from './useModelVisionToggle';

interface useInputUiStateInput {
  input: string
  syncTimeoutRef: React.RefObject<NodeJS.Timeout | null>
  onInputChange: ((value: string) => void) | undefined
  prevInputValueRef: React.RefObject<string>
  externalInputRef: React.RefObject<RichTextInputHandle | null> | undefined
  sessionId: string | undefined
  isFocusedPanel: boolean
  setInput: React.Dispatch<React.SetStateAction<string>>
  syncToParent: (value: string) => void
}

export function useInputUiState({
  input,
  syncTimeoutRef,
  onInputChange,
  prevInputValueRef,
  externalInputRef,
  sessionId,
  isFocusedPanel,
  setInput,
  syncToParent,
}: useInputUiStateInput) {
const inputRef = React.useRef(input)

inputRef.current = input

React.useEffect(() => {
    const pendingSync = syncTimeoutRef;
    return () => {
      // Cancel pending debounced sync
      // The latest timer must be cleared when this component unmounts.
      if (pendingSync.current) clearTimeout(pendingSync.current)
      // Immediately sync current value to parent on unmount
      // This preserves input when switching to structured input (e.g., permission request)
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current)
      }
    }
  }, [onInputChange, prevInputValueRef, syncTimeoutRef])

const [isDraggingOver, setIsDraggingOver] = React.useState(false)

const [loadingCount, setLoadingCount] = React.useState(0)

const [, setIsFocused] = React.useState(false)

const [inputMaxHeight, setInputMaxHeight] = React.useState(540)

const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

const [autoCapitalisation, setAutoCapitalisation] = React.useState(true)

const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')

const [spellCheck, setSpellCheck] = React.useState(false)

React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

const { showEscapeOverlay } = useEscapeInterrupt()

React.useEffect(() => {
    const updateMaxHeight = (viewportHeight = readUsableViewportHeight()) => {
      const maxFromWindow = Math.floor(viewportHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    return subscribeToViewportHeight(updateMaxHeight)
  }, [])

const dragCounterRef = React.useRef(0)

const containerRef = React.useRef<HTMLDivElement>(null)

const fileInputRef = React.useRef<HTMLInputElement>(null)

const internalInputRef = React.useRef<RichTextInputHandle>(null)

const richInputRef = externalInputRef || internalInputRef

const lastCaretPositionRef = React.useRef<number | null>(null)

React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ ...(sessionId !== undefined ? { sessionId: sessionId } : {}), isFocusedPanel, ...(targetSessionId !== undefined ? { targetSessionId: targetSessionId } : {}) })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus()
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('craft:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('craft:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef, setInput])

const clearInputDraft = React.useCallback(() => {
    setInput('')
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    prevInputValueRef.current = ''
  }, [onInputChange, prevInputValueRef, setInput, syncTimeoutRef])

const handleToggleModelVision = useModelVisionToggle()
return { clearInputDraft, richInputRef, lastCaretPositionRef, setLoadingCount, containerRef, fileInputRef, dragCounterRef, setIsDraggingOver, sendMessageKey, inputRef, autoCapitalisation, isDraggingOver, handleToggleModelVision, loadingCount, setIsFocused, inputMaxHeight, spellCheck, showEscapeOverlay, modelDropdownOpen, setModelDropdownOpen }
}
