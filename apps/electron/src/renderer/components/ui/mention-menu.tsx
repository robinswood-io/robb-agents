import * as React from 'react';
import "react-i18next";
import "@/lib/utils";
import "@/components/ui/fading-text";
import "@/components/ui/skill-avatar";
import "@/components/ui/source-avatar";
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types';
import { isValidMentionTrigger } from './mention-trigger';
export { isValidMentionTrigger } from './mention-trigger'

import { type MentionItem, type MentionSection, filterCacheResults, type UseInlineMentionOptions, type UseInlineMentionReturn } from "./mention-menu-view";
export { type MentionItemType, type MentionItem, type MentionSection, type InlineMentionMenuProps, InlineMentionMenu, type MentionInputElement, type UseInlineMentionOptions, type UseInlineMentionReturn } from "./mention-menu-view";






import type { FileSearchResult } from '../../../shared/types';





export function useInlineMention({
  inputRef,
  skills,
  sources,
  basePath,
  onSelect,
  workspaceId,
}: UseInlineMentionOptions): UseInlineMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  // committedFilter: only updates when IPC returns (or immediately when no IPC needed).
  // Prevents visual jumps — the menu shows all items until results are ready,
  // then applies filter + file results in a single frame.
  const [committedFilter, setCommittedFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  const [fileResults, setFileResults] = React.useState<MentionItem[]>([])
  const fileSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache of raw IPC file search results for the current menu session.
  // Allows instant client-side filtering when user edits the query (add/delete chars)
  // without waiting for a new IPC round-trip. Cleared when menu closes.
  const fileCache = React.useRef<FileSearchResult[]>([])
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Cleanup pending timeout on unmount
  React.useEffect(() => {
    return () => {
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
      }
    }
  }, [])

  // Build sections from available data (skills, sources, and file search results)
  const sections = React.useMemo((): MentionSection[] => {
    const result: MentionSection[] = []

    // Skills section
    if (skills.length > 0) {
      result.push({
        id: 'skills',
        label: 'Skills',
        items: skills.map(skill => ({
          id: skill.slug,
          type: 'skill' as const,
          label: skill.metadata.name,
          description: skill.metadata.description,
          skill,
        })),
      })
    }

    // Sources section
    if (sources.length > 0) {
      result.push({
        id: 'sources',
        label: 'Sources',
        items: sources
          .filter(source => source.config.slug && source.config.name)
          .map(source => ({
            id: source.config.slug,
            type: 'source' as const,
            label: source.config.name,
            description: source.config.tagline,
            source,
          })),
      })
    }

    // Files section (from async search results)
    if (fileResults.length > 0) {
      result.push({
        id: 'files',
        label: 'Files',
        items: fileResults,
      })
    }

    return result
  }, [skills, sources, fileResults])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match @ followed by up to 100 chars (word chars, hyphens, slashes, dots, and spaces).
    // Spaces are allowed so users can type filenames with spaces (e.g. @app availability.md).
    // The menu auto-closes when a space produces no matches (Slack-style behavior).
    const atMatch = textBeforeCursor.match(/@([\w\-\/.\s]{0,100})?$/)

    // Check if this is a valid @ mention trigger
    const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
    const isValidTrigger = atMatch && isValidMentionTrigger(textBeforeCursor, matchStart)

    if (isValidTrigger) {
      const filterText = atMatch[1] || ''

      // Slack-style auto-close: if the query contains a space and the file cache is
      // populated but produces zero matches, close the menu. This prevents the
      // "infinite spaces" problem while still allowing multi-word queries like
      // "app availability.md". Skills/sources rarely have spaces in names, so
      // file cache is the authoritative signal here.
      if (filterText.includes(' ') && fileCache.current.length > 0) {
        const fileMatches = filterCacheResults(fileCache.current, filterText)
        if (fileMatches.length === 0) {
          setIsOpen(false)
          setFilter('')
          setCommittedFilter('')
          setAtStart(-1)
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          setFileResults([])
          fileCache.current = []
          return
        }
      }

      setAtStart(matchStart)
      setFilter(filterText)

      // Cache-first file search: if cache has entries from a previous IPC call,
      // filter client-side instantly (no IPC, no debounce). Otherwise fire a
      // debounced IPC to populate the cache. Cache clears when menu closes.
      window.electronAPI.debugLog('[mention] filterText:', filterText, 'basePath:', basePath, 'cacheSize:', fileCache.current.length)
      if (basePath && filterText.length >= 1) {
        if (fileCache.current.length > 0) {
          // Cache exists — filter client-side instantly, no IPC needed
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          const filtered = filterCacheResults(fileCache.current, filterText)
          window.electronAPI.debugLog('[mention] cache hit:', filtered.length, 'items')
          setFileResults(filtered)
          setCommittedFilter(filterText)
        } else {
          // First search — fire debounced IPC to populate cache
          if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current)

          fileSearchTimeout.current = setTimeout(async () => {
            try {
              window.electronAPI.debugLog('[mention] calling IPC searchFiles:', basePath, filterText)
              const results = await window.electronAPI.searchFiles(basePath, filterText)
              window.electronAPI.debugLog('[mention] IPC returned:', results?.length, 'results')
              fileCache.current = results
              const filtered = filterCacheResults(fileCache.current, filterText)
              window.electronAPI.debugLog('[mention] after cache filter:', filtered.length, 'items')
              setFileResults(filtered)
              setCommittedFilter(filterText)
            } catch (err) {
              window.electronAPI.debugLog('[mention] IPC searchFiles error:', String(err))
            }
          }, 150)
        }
      } else {
        window.electronAPI.debugLog('[mention] skipping file search (no basePath or empty filter)')
        if (fileSearchTimeout.current) {
          clearTimeout(fileSearchTimeout.current)
          fileSearchTimeout.current = null
        }
        setFileResults([])
        setCommittedFilter(filterText)
      }

      if (inputRef.current) {
        // Try to get actual caret position from the input element
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // Use actual caret position
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setCommittedFilter('')
      setAtStart(-1)
      // Clear file search state and cache when menu closes
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
        fileSearchTimeout.current = null
      }
      setFileResults([])
      fileCache.current = []
    }
  }, [inputRef, basePath])

  const handleSelect = React.useCallback((item: MentionItem): { value: string; cursorPosition: number } => {
    let result = ''
    let newCursorPosition = 0

    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)

      const buildMentionText = (kind: 'skill' | 'source' | 'file' | 'folder', value: string): string =>
        '[' + kind + ':' + value + '] '

      // Build the mention text based on type using bracket syntax.
      // Skills use fully-qualified names (workspaceId:slug) because the SDK's
      // Skill tool requires this format to resolve workspace-scoped skills.
      let mentionText: string
      if (item.type === 'skill') {
        // Plugin name depends on which tier the skill came from:
        //   workspace → workspaceId, project/global → ".agents"
        const pluginName = item.skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
        const qualifiedName = pluginName ? `${pluginName}:${item.id}` : item.id
        mentionText = buildMentionText('skill', qualifiedName)
      } else if (item.type === 'source') {
        mentionText = buildMentionText('source', item.id)
      } else if (item.type === 'file') {
        // Use relative path for file mentions
        mentionText = buildMentionText('file', item.file?.relativePath || item.id)
      } else if (item.type === 'folder') {
        mentionText = buildMentionText('folder', item.file?.relativePath || item.id)
      } else {
        mentionText = buildMentionText('skill', item.id)
      }

      result = before + mentionText + after
      newCursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setCommittedFilter('')
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []

    return { value: result, cursorPosition: newCursorPosition }
  }, [onSelect, atStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setCommittedFilter('')
    setAtStart(-1)
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []
  }, [])

  return {
    isOpen,
    filter: committedFilter,
    position,
    sections,
    isSearching: false,
    handleInputChange,
    close,
    handleSelect,
  }
}
