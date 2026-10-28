import * as React from 'react';
import { useMemo, useEffect } from 'react';

import { BUFFER_CONFIG, shouldShowContent } from "./turn-card-buffering";

interface useResponseBufferInput {
  isStreaming: boolean
  setDisplayedText: React.Dispatch<React.SetStateAction<string>>
  text: string
  lastUpdateRef: React.RefObject<number>
  streamStartTime: number | undefined
  variant: "response" | "plan"
  presentation: "default" | "codex"
}

export function useResponseBuffer({
  isStreaming,
  setDisplayedText,
  text,
  lastUpdateRef,
  streamStartTime,
  variant,
  presentation,
}: useResponseBufferInput) {
useEffect(() => {
    if (!isStreaming) {
      // Streaming ended - show final content immediately
      setDisplayedText(text)
      return undefined;
    }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    if (elapsed >= BUFFER_CONFIG.CONTENT_THROTTLE_MS) {
      // Enough time passed - update immediately
      setDisplayedText(text)
      lastUpdateRef.current = now
    } else {
      // Schedule update for remaining time
      const timeout = setTimeout(() => {
        setDisplayedText(text)
        lastUpdateRef.current = Date.now()
      }, BUFFER_CONFIG.CONTENT_THROTTLE_MS - elapsed)
      return () => clearTimeout(timeout)
    }
  
    return undefined;
  }, [text, isStreaming])

const bufferDecision = useMemo(() => {
    return shouldShowContent(text, isStreaming, streamStartTime)
  }, [text, isStreaming, streamStartTime])

const isCompleted = !isStreaming

const isBuffering = isStreaming && !bufferDecision.shouldShow

const isPlan = variant === 'plan'

const isCodexPresentation = presentation === 'codex' && !isPlan
return { isBuffering, isCompleted, isCodexPresentation, isPlan }
}
