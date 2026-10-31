import * as React from 'react';
import { useTranslation } from "react-i18next";
import { Command as CommandPrimitive } from 'cmdk';
import { Check, Minimize2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { PERMISSION_MODE_CONFIG, PERMISSION_MODE_ORDER, type PermissionMode } from '@craft-agent/shared/agent/modes';


// ============================================================================
// Types
// ============================================================================

export type SlashCommandId = PermissionMode | 'compact'


/** Union type for all item types in the slash menu */
export type SlashItemType = 'command' | 'folder'


export interface SlashCommand {
  id: SlashCommandId
  label: string
  description: string
  icon: React.ReactNode
  shortcut?: string
  /** Optional color for the command (hex color string) */
  color?: string
}


/** Folder item for the slash menu */
export interface SlashFolderItem {
  id: string
  type: 'folder'
  label: string
  description: string
  path: string
}


/** Section with header for the inline slash menu */
export interface SlashSection {
  id: string
  label: string
  items: (SlashCommand | SlashFolderItem)[]
}


export interface CommandGroup {
  id: string
  commands: SlashCommand[]
}


// ============================================================================
// Permission Mode Icon Component
// ============================================================================

export interface PermissionModeIconProps {
  mode: PermissionMode
  className?: string | undefined
}


export function PermissionModeIcon({ mode, className }: PermissionModeIconProps) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}


// ============================================================================
// Default Commands
// ============================================================================

// Icon size constant
export const MENU_ICON_SIZE = 'h-3.5 w-3.5'


// Generate permission mode commands from centralized config
export const permissionModeCommands: SlashCommand[] = PERMISSION_MODE_ORDER.map(mode => {
  const config = PERMISSION_MODE_CONFIG[mode]
  return {
    id: mode,
    label: config.displayName,
    description: config.description,
    icon: <PermissionModeIcon mode={mode} className={MENU_ICON_SIZE} />,
  }
})


export const compactCommand: SlashCommand = {
  id: 'compact',
  label: 'Compact Context',
  description: 'Summarize conversation context to free up token budget',
  icon: <Minimize2 className={MENU_ICON_SIZE} />,
}


export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  ...permissionModeCommands,
  compactCommand,
]


export const DEFAULT_SLASH_COMMAND_GROUPS: CommandGroup[] = [
  { id: 'modes', commands: permissionModeCommands },
]


// ============================================================================
// Shared Styles
// ============================================================================

export const MENU_CONTAINER_STYLE = 'min-w-[200px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'

export const MENU_LIST_STYLE = 'max-h-[260px] overflow-y-auto py-1'

export const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'

export const MENU_ITEM_SELECTED = 'bg-foreground/5'

export const MENU_SECTION_HEADER = 'px-3 py-1.5 mb-0.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5'


// ============================================================================
// Shared: Filter utilities
// ============================================================================

export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  if (!filter) return commands
  const lowerFilter = filter.toLowerCase()
  return commands.filter(
    cmd =>
      cmd.label.toLowerCase().includes(lowerFilter) ||
      cmd.id.toLowerCase().includes(lowerFilter)
  )
}


/** Check if an item is a folder */
export function isFolder(item: SlashCommand | SlashFolderItem): item is SlashFolderItem {
  return 'type' in item && item.type === 'folder'
}


/** Filter sections by label/id, keeping sections grouped */
export function filterSections(sections: SlashSection[], filter: string): SlashSection[] {
  if (!filter) return sections
  const lowerFilter = filter.toLowerCase()

  // Filter items within each section, keeping section structure
  return sections
    .map(section => ({
      ...section,
      items: section.items.filter(item =>
        item.label.toLowerCase().includes(lowerFilter) ||
        item.id.toLowerCase().includes(lowerFilter) ||
        item.description?.toLowerCase().includes(lowerFilter)
      ),
    }))
    .filter(section => section.items.length > 0)
}


/** Flatten sections into a single array of items */
export function flattenSections(sections: SlashSection[]): (SlashCommand | SlashFolderItem)[] {
  return sections.flatMap(section => section.items)
}


// ============================================================================
// Shared: Command Item Content
// ============================================================================

export const MODE_COMMAND_IDS = new Set<string>(['safe', 'ask', 'allow-all'])


export function CommandItemContent({ command, isActive }: { command: SlashCommand; isActive: boolean }) {
  const { t } = useTranslation()
  const label = MODE_COMMAND_IDS.has(command.id) ? t(`mode.${command.id}`, command.label) : command.label
  return (
    <>
      <div className="shrink-0 text-muted-foreground">{command.icon}</div>
      <div className="flex-1 min-w-0">{label}</div>
      {isActive && (
        <div className="shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center">
          <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
        </div>
      )}
    </>
  )
}


// ============================================================================
// SlashCommandMenu Component (Button-triggered popup)
// ============================================================================

export interface SlashCommandMenuProps {
  /** Flat list of commands (use this OR commandGroups, not both) */
  commands?: SlashCommand[] | undefined
  /** Grouped commands with separators between groups */
  commandGroups?: CommandGroup[] | undefined
  activeCommands?: SlashCommandId[] | undefined
  onSelect: (commandId: SlashCommandId) => void
  showFilter?: boolean | undefined
  filterPlaceholder?: string | undefined
  className?: string | undefined
}


export function SlashCommandMenu({
  commands,
  commandGroups,
  activeCommands = [],
  onSelect,
  showFilter = false,
  filterPlaceholder,
  className,
}: SlashCommandMenuProps) {
  const { t } = useTranslation()
  const effectiveFilterPlaceholder = filterPlaceholder ?? t("commands.searchCommands")
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // If groups provided, filter within each group; otherwise use flat commands
  const filteredGroups = React.useMemo(() => {
    if (commandGroups) {
      return commandGroups.map(group => ({
        ...group,
        commands: filterCommands(group.commands, filter),
      })).filter(group => group.commands.length > 0)
    }
    return null
  }, [commandGroups, filter])

  const filteredCommands = React.useMemo(() => {
    if (commands && !commandGroups) {
      return filterCommands(commands, filter)
    }
    return null
  }, [commands, commandGroups, filter])

  // Get all commands for defaultValue calculation
  const allFilteredCommands = filteredGroups
    ? filteredGroups.flatMap(g => g.commands)
    : (filteredCommands ?? [])

  // Default to the first active command, or first command if none active
  const defaultValue = activeCommands[0] ?? allFilteredCommands[0]?.id

  React.useEffect(() => {
    // Don't auto-focus the filter on touch devices — it pulls up the virtual keyboard
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (showFilter && inputRef.current && !isTouchDevice) {
      inputRef.current.focus()
    }
  }, [showFilter])

  if (allFilteredCommands.length === 0 && !showFilter) return null

  // Render a single command item
  const renderCommandItem = (cmd: SlashCommand) => {
    const isActive = activeCommands.includes(cmd.id)
    return (
      <CommandPrimitive.Item
        key={cmd.id}
        value={cmd.id}
        onSelect={() => onSelect(cmd.id)}
        data-tutorial={`permission-mode-${cmd.id}`}
        className={cn(
          MENU_ITEM_STYLE,
          'outline-none',
          'data-[selected=true]:bg-foreground/5'
        )}
      >
        <CommandItemContent command={cmd} isActive={isActive} />
      </CommandPrimitive.Item>
    )
  }

  return (
    <CommandPrimitive
      className={cn(MENU_CONTAINER_STYLE, className)}
      shouldFilter={false}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
    >
      {showFilter && (
        <div className="border-b border-border/50 px-3 py-2">
          <CommandPrimitive.Input
            ref={inputRef}
            value={filter}
            onValueChange={setFilter}
            placeholder={effectiveFilterPlaceholder}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        {allFilteredCommands.length === 0 ? (
          <CommandPrimitive.Empty className="py-4 text-center text-sm text-muted-foreground">
            No commands found
          </CommandPrimitive.Empty>
        ) : filteredGroups ? (
          // Group-based rendering with smart separators
          filteredGroups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {group.commands.map(renderCommandItem)}
              {/* Separator: only show if there's another group after this one */}
              {groupIndex < filteredGroups.length - 1 && (
                <div className="h-px bg-border/50 my-1 mx-2" />
              )}
            </React.Fragment>
          ))
        ) : (
          // Flat list rendering
          filteredCommands?.map(renderCommandItem)
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}


// ============================================================================
// InlineSlashCommand - Autocomplete that follows cursor
// ============================================================================

export interface InlineSlashCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: SlashSection[]
  activeCommands?: SlashCommandId[] | undefined
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  filter?: string | undefined
  position: { x: number; y: number }
  className?: string | undefined
}


// ============================================================================
// Hook for managing inline slash command state
// ============================================================================

/** Interface for elements that can be used with useInlineSlashCommand */
export interface SlashCommandInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}


/**
 * Format path for display, shortening home directory
 */
export function formatPathForDisplay(path: string, homeDir?: string): string {
  if (homeDir && path.startsWith(homeDir)) {
    return '~' + path.slice(homeDir.length)
  }
  return path
}


/**
 * Get folder name from path
 */
export function getFolderName(path: string): string {
  return path.split('/').pop() || path
}


export interface UseInlineSlashCommandOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<SlashCommandInputElement | null>
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  activeCommands?: SlashCommandId[]
  recentFolders?: string[]
  homeDir?: string
}


export interface UseInlineSlashCommandReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: SlashSection[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  activeCommands: SlashCommandId[]
  handleSelectCommand: (commandId: SlashCommandId) => string
  handleSelectFolder: (path: string) => string
}
