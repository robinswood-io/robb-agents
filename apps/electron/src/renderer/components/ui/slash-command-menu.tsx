import * as React from 'react';
import "react-i18next";
import "cmdk";
import "lucide-react";
import { Icon_Folder } from '@craft-agent/ui';
import { cn } from '@/lib/utils';
import "@craft-agent/shared/agent/modes";

import { type SlashCommandId, type SlashCommand, type SlashFolderItem, type SlashSection, MENU_ICON_SIZE, permissionModeCommands, compactCommand, MENU_CONTAINER_STYLE, MENU_LIST_STYLE, MENU_ITEM_STYLE, MENU_ITEM_SELECTED, MENU_SECTION_HEADER, isFolder, filterSections, flattenSections, CommandItemContent, type InlineSlashCommandProps, formatPathForDisplay, getFolderName, type UseInlineSlashCommandOptions, type UseInlineSlashCommandReturn } from "./slash-command-view";
export { type SlashCommandId, type SlashItemType, type SlashCommand, type SlashFolderItem, type SlashSection, type CommandGroup, DEFAULT_SLASH_COMMANDS, DEFAULT_SLASH_COMMAND_GROUPS, type SlashCommandMenuProps, SlashCommandMenu, type InlineSlashCommandProps, type SlashCommandInputElement, type UseInlineSlashCommandOptions, type UseInlineSlashCommandReturn } from "./slash-command-view";








export function InlineSlashCommand({
  open,
  onOpenChange,
  sections,
  activeCommands = [],
  onSelectCommand,
  onSelectFolder,
  filter = '',
  position,
  className,
}: InlineSlashCommandProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenSections(filteredSections)

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Handle item selection
  const handleSelect = React.useCallback((item: SlashCommand | SlashFolderItem) => {
    if (isFolder(item)) {
      onSelectFolder(item.path)
    } else {
      onSelectCommand(item.id)
    }
    onOpenChange(false)
  }, [onSelectCommand, onSelectFolder, onOpenChange])

  // Keyboard navigation
  // Don't attach listener when no items - allows Enter to propagate to input handler
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            handleSelect(flatItems[selectedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatItems, selectedIndex, handleSelect, onOpenChange])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // Hide if no results or not open
  if (!open || flatItems.length === 0) return null

  // Calculate bottom position from window height (menu appears above cursor)
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  // Track current item index across all sections
  let currentItemIndex = 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition, minWidth: 220, maxWidth: 260 }}
    >
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {filteredSections.map((section, _sectionIndex) => (
          <React.Fragment key={section.id}>
            {/* Section header */}
            <div className={MENU_SECTION_HEADER}>
              {section.label}
            </div>

            {/* Section items */}
            {section.items.map((item) => {
              const itemIndex = currentItemIndex++
              const isSelected = itemIndex === selectedIndex

              if (isFolder(item)) {
                // Folder item - single line with path
                return (
                  <div
                    key={`${section.id}-${item.id}`}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <div className="shrink-0 text-muted-foreground">
                      <Icon_Folder className={MENU_ICON_SIZE} strokeWidth={1.75} />
                    </div>
                    <div className="flex-1 min-w-0 truncate">
                      <span>{item.label}</span>
                      <span className="text-muted-foreground ml-1.5">{item.description}</span>
                    </div>
                  </div>
                )
              } else {
                // Command item
                const isActive = activeCommands.includes(item.id)
                return (
                  <div
                    key={item.id}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <CommandItemContent command={item} isActive={isActive} />
                  </div>
                )
              }
            })}

          </React.Fragment>
        ))}
      </div>
      {/* Always-visible footer hint for @ mentions */}
      <div className="h-px bg-border/50 mx-2" />
      <div className="px-3 py-2.5 select-none text-xs text-muted-foreground">
        Use @ for skills and files
      </div>
    </div>
  )
}

export function useInlineSlashCommand({
  inputRef,
  onSelectCommand,
  onSelectFolder,
  activeCommands = [],
  recentFolders = [],
  homeDir,
}: UseInlineSlashCommandOptions): UseInlineSlashCommandReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [slashStart, setSlashStart] = React.useState(-1)
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Build sections from commands and folders
  const sections = React.useMemo((): SlashSection[] => {
    const result: SlashSection[] = []

    // Modes section
    result.push({
      id: 'modes',
      label: 'Modes',
      items: permissionModeCommands,
    })

    // Commands section
    result.push({
      id: 'commands',
      label: 'Commands',
      items: [compactCommand],
    })

    // Recent folders section - sorted alphabetically by folder name, show all
    if (recentFolders.length > 0) {
      const sortedFolders = [...recentFolders]
        .sort((a, b) => {
          const nameA = getFolderName(a).toLowerCase()
          const nameB = getFolderName(b).toLowerCase()
          return nameA.localeCompare(nameB)
        })

      result.push({
        id: 'folders',
        label: 'Recent Working Directories',
        items: sortedFolders.map(path => ({
          id: path,
          type: 'folder' as const,
          label: getFolderName(path),
          description: formatPathForDisplay(path, homeDir),
          path,
        })),
      })
    }

    return result
  }, [recentFolders, homeDir])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\w*)$/)

    // Only show menu if we have sections with items
    const hasItems = sections.some(s => s.items.length > 0)

    if (slashMatch && hasItems) {
      const filterText = slashMatch[1] || ''
      // Check if there are any filtered results before opening menu
      // This ensures Enter key works normally when no matches exist
      const filteredSections = filterSections(sections, filterText)
      const hasFilteredItems = filteredSections.some(s => s.items.length > 0)

      if (!hasFilteredItems) {
        // No results after filtering - close menu to allow normal Enter handling
        setIsOpen(false)
        setFilter('')
        setSlashStart(-1)
        return
      }

      const matchStart = textBeforeCursor.lastIndexOf('/')
      setSlashStart(matchStart)
      setFilter(filterText)

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
      setSlashStart(-1)
    }
  }, [inputRef, sections])

  const handleSelectCommand = React.useCallback((commandId: SlashCommandId): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    // Now safe to trigger state changes
    onSelectCommand(commandId)
    setIsOpen(false)

    return result
  }, [onSelectCommand, slashStart])

  const handleSelectFolder = React.useCallback((path: string): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    // Folder selection directly changes working directory, doesn't insert text
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      // Just remove the /command text, no badge insertion
      result = (before + after).trim()
    }

    // Trigger working directory change
    onSelectFolder(path)
    setIsOpen(false)

    return result
  }, [onSelectFolder, slashStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setSlashStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    sections,
    handleInputChange,
    close,
    activeCommands,
    handleSelectCommand,
    handleSelectFolder,
  }
}
