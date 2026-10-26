import * as React from 'react';

import { coerceInputText } from '@/lib/input-text';

import type { FileAttachment } from '../../../../shared/types';

interface useInputAttachmentSyncInput {
  attachments: FileAttachment[]
  attachmentsValue: FileAttachment[] | undefined
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>
  onAttachmentsChange: ((attachments: FileAttachment[]) => void) | undefined
  inputValue: string | undefined
  setInput: React.Dispatch<React.SetStateAction<string>>
  onInputChange: ((value: string) => void) | undefined
}

export function useInputAttachmentSync({
  attachments,
  attachmentsValue,
  setAttachments,
  onAttachmentsChange,
  inputValue,
  setInput,
  onInputChange,
}: useInputAttachmentSyncInput) {
const attachmentsRef = React.useRef<FileAttachment[]>([])

React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])

const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)

const skipPersistRef = React.useRef(true)

React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey, setAttachments])

const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)

onAttachmentsChangeRef.current = onAttachmentsChange

React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

const prevInputValueRef = React.useRef(coerceInputText(inputValue))

React.useEffect(() => {
    if (inputValue === undefined) return
    const nextInputValue = coerceInputText(inputValue)
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue)
      prevInputValueRef.current = nextInputValue
    }
  }, [inputValue, setInput])

const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)

const syncToParent = React.useCallback((value: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      onInputChange(value)
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange])
return { syncTimeoutRef, prevInputValueRef, syncToParent, attachmentsRef }
}
