import * as React from 'react';

import { isCompatProvider, modelSupportsImages } from '@config/llm-connections';

import type { FileAttachment } from '../../../../shared/types';

import { type FollowUpInputItem } from "./free-form-input-contracts";

interface useInputLayoutInput {
  followUpItems: FollowUpInputItem[]
  input: string
  attachments: FileAttachment[]
  effectiveConnectionDetails: import("@config/llm-connections").LlmConnectionWithStatus | null
  currentModel: string
}

export function useInputLayout({
  followUpItems,
  input,
  attachments,
  effectiveConnectionDetails,
  currentModel,
}: useInputLayoutInput) {
const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )

const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)

const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0

const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))

const showVisionWarning =
    hasStagedImages
    && !!effectiveConnectionDetails
    && isCompatProvider(effectiveConnectionDetails.providerType)
    && !modelSupportsImages(effectiveConnectionDetails, currentModel)
return { showVisionWarning, animateFollowUpLayout, hasContent }
}
