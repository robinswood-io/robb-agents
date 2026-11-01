import * as React from "react";

import { useState } from "react";

import type { RichTextInputHandle } from "@/components/ui/rich-text-input";

interface useChatScrollStateInput {
  disabled: boolean
  isFocusedPanel: boolean
  externalTextareaRef: React.RefObject<RichTextInputHandle | null> | undefined
}

export function useChatScrollState({
  disabled,
  isFocusedPanel,
  externalTextareaRef,
}: useChatScrollStateInput) {
const isInputDisabled = disabled

const messagesEndRef = React.useRef<HTMLDivElement>(null)

const scrollViewportRef = React.useRef<HTMLDivElement>(null)

const prevSessionIdRef = React.useRef<string | null>(null)

const TURNS_PER_PAGE = 20

const [visibleTurnCount, setVisibleTurnCount] = React.useState(TURNS_PER_PAGE)

const isStickToBottomRef = React.useRef(true)

const [showScrollToLatest, setShowScrollToLatest] = React.useState(false)

const isFocusedPanelRef = React.useRef(isFocusedPanel)

isFocusedPanelRef.current = isFocusedPanel

const skipSmoothScrollUntilRef = React.useRef(0)

const handleInitialTranscriptScroll = React.useCallback(() => {
    isStickToBottomRef.current = true
    setShowScrollToLatest(false)
    skipSmoothScrollUntilRef.current = Date.now() + 500
  }, [])

const prevLastMessageIdRef = React.useRef<string | null>(null)

const prevMessageCountRef = React.useRef(0)

const prevSessionIdForCommitScrollRef = React.useRef<string | null>(null)

const internalTextareaRef = React.useRef<RichTextInputHandle>(null)

const textareaRef = externalTextareaRef || internalTextareaRef

const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')

const [openAnnotationRequest, setOpenAnnotationRequest] = React.useState<{
    messageId: string
    annotationId: string
    mode: 'view' | 'edit'
    anchorX?: number
    anchorY?: number
    nonce: number
  } | null>(null)

const followUpOpenNonceRef = React.useRef(0)
return { isFocusedPanelRef, textareaRef, setSendMessageKey, visibleTurnCount, setVisibleTurnCount, scrollViewportRef, isStickToBottomRef, setShowScrollToLatest, TURNS_PER_PAGE, prevSessionIdRef, messagesEndRef, skipSmoothScrollUntilRef, prevSessionIdForCommitScrollRef, prevLastMessageIdRef, prevMessageCountRef, isInputDisabled, followUpOpenNonceRef, setOpenAnnotationRequest, handleInitialTranscriptScroll, sendMessageKey, openAnnotationRequest, showScrollToLatest }
}
