import { omitUndefined } from '@craft-agent/shared/utils/json';
import * as React from 'react';

import { type RichTextInputHandle } from '@/components/ui/rich-text-input';

import type { FileAttachment } from '../../../../shared/types';

interface useInputAttachmentEventsInput {
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>
  setLoadingCount: React.Dispatch<React.SetStateAction<number>>
  disabled: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  dragCounterRef: React.RefObject<number>
  setIsDraggingOver: React.Dispatch<React.SetStateAction<boolean>>
  getNextPastedNumber: (prefix: "image" | "text" | "file", existingAttachments: FileAttachment[]) => number
  attachmentsRef: React.RefObject<FileAttachment[]>
  richInputRef: React.RefObject<RichTextInputHandle | null>
}

export function useInputAttachmentEvents({
  setAttachments,
  setLoadingCount,
  disabled,
  fileInputRef,
  dragCounterRef,
  setIsDraggingOver,
  getNextPastedNumber,
  attachmentsRef,
  richInputRef,
}: useInputAttachmentEventsInput) {
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

const processFileAttachment = async (file: File, overrideName?: string) => {
    try {
      const attachment = await readFileAsAttachment(file, overrideName)
      if (attachment) {
        setAttachments(prev => [...prev, attachment])
      }
    } catch (error) {
      console.error('[FreeFormInput] Failed to read file:', error)
    }
    setLoadingCount(prev => prev - 1)
  }

const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setLoadingCount(prev => prev + fileList.length)

    for (const file of fileList) {
      await processFileAttachment(file)
    }

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = ''
  }

const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // When null, the draft layer falls back to persisting content inline (Track C).
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        let type: FileAttachment['type'] = 'unknown'
        const fileName = overrideName || file.name
        if (file.type.startsWith('image/')) type = 'image'
        else if (file.type === 'application/pdf') type = 'pdf'
        else if (file.type.includes('text') || fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)) type = 'text'
        else if (file.type.includes('officedocument') || fileName.match(/\.(docx?|xlsx?|pptx?)$/i)) type = 'office'

        const mimeType = file.type || 'application/octet-stream'

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve(omitUndefined<FileAttachment>({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        }))
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // We have files to process - prevent default text paste behavior
    e.preventDefault()

    const files = Array.from(clipboardItems)
    setLoadingCount(prev => prev + files.length)

    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    for (const [i, file] of files.entries()) {
      await processFileAttachment(file, fileNames[i])
    }
  }

const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
    }
    setAttachments(prev => [...prev, attachment])
    // Focus input after adding attachment
    richInputRef.current?.focus()
  }, [ attachmentsRef, getNextPastedNumber, richInputRef, setAttachments])

const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    const files = Array.from(e.dataTransfer.files)
    setLoadingCount(files.length)

    for (const file of files) {
      await processFileAttachment(file)
    }
  }
return { readFileAsAttachment, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleRemoveAttachment, handlePaste, handleLongTextPaste, handleFileInputChange, handleAttachClick }
}
