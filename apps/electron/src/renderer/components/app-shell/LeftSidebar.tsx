import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import "lucide-react";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuTrigger, StyledContextMenuContent } from '@/components/ui/styled-context-menu';
import { ContextMenuProvider } from '@/components/ui/menu-context';
import { SidebarMenu } from './SidebarMenu';
import "@/components/ui/sortable-list";

import { type LinkItem, isSeparatorItem, type LeftSidebarProps, containerVariants, itemVariants, SortableStatusList, SidebarButton } from "./left-sidebar-items";
export { type SidebarContextMenuConfig, type SortableConfig, type LinkItem, type SeparatorItem, type SidebarItem, isSeparatorItem } from "./left-sidebar-items";











/**
 * LeftSidebar - Vertical list of navigation buttons with icons
 *
 * Navigation is managed by the parent component (Chat.tsx) for unified
 * sidebar keyboard navigation. This component just renders the items.
 *
 * Styling matches agent items in the sidebar for consistency:
 * - py-[7px] px-2 text-[13px] rounded-md
 * - Icon: h-3.5 w-3.5
 *
 * Link variants:
 * - "default": Highlighted style (used for active/selected items)
 * - "ghost": Subtle style (used for inactive items)
 *
 * Expandable items:
 * - Show a chevron toggle on hover (replaces icon position)
 * - Children are rendered with animated expand/collapse
 * - Nested items have left indentation with vertical line
 *
 * Drag-and-drop:
 * - Expandable items can opt-in to sortable (flat) or sortableTree (hierarchical) DnD
 * - Uses @dnd-kit with DragOverlay portaled to document.body (no clipping)
 * - Two-phase drop animation: overlay fades out, ghost fades in
 */
export function LeftSidebar({ links, isCollapsed, getItemProps, focusedItemId, isNested }: LeftSidebarProps) {
  // For nested sidebars, wrap in motion container for stagger effect
  const NavWrapper = isNested ? motion.nav : 'nav'
  const navProps = isNested ? {
    variants: containerVariants,
    initial: 'hidden',
    animate: 'visible',
    exit: 'exit',
  } : {}

  return (
    <div className={cn("flex flex-col select-none", !isNested && "py-1")}>
      <NavWrapper
        className={cn(
          "grid gap-0.5",
          isNested ? "pl-5 pr-0 relative" : "px-2"
        )}
        role="navigation"
        aria-label={isNested ? "Sub navigation" : "Main navigation"}
        {...navProps}
      >
        {/* Vertical line for nested items - 4px left of chevron center */}
        {isNested && (
          <div
            className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
            aria-hidden="true"
          />
        )}
        {links.map((item) => {
          // Handle separator items
          if (isSeparatorItem(item)) {
            return (
              <div key={item.id} className="py-1 px-2" aria-hidden="true">
                <div className="h-px bg-foreground/5" />
              </div>
            )
          }

          const link = item
          const itemProps = getItemProps?.(link.id)
          const isFocused = focusedItemId === link.id

          // Button element shared by both expandable and non-expandable items
          const buttonElement = (
            <SidebarButton
              link={link}
              itemProps={itemProps}
            />
          )

          // Determine which expanded content to render (sortable vs regular)
          const expandedContent = link.expandable && link.items && link.expanded
            ? renderExpandedContent(link, getItemProps, focusedItemId, isNested)
            : null

          // Wrap with context menu if configured, scoped to button only.
          // ContextMenuTrigger with asChild sets data-state="open" on the button
          // so only the clicked item highlights, not the entire section.
          const content = (
            <div className="group/section">
              {link.contextMenu ? (
                <ContextMenu modal={true}>
                  <ContextMenuTrigger asChild>
                    {buttonElement}
                  </ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <ContextMenuProvider>
                      <SidebarMenu
                        type={link.contextMenu.type}
                        statusId={link.contextMenu.statusId}
                        labelId={link.contextMenu.labelId}
                        onConfigureStatuses={link.contextMenu.onConfigureStatuses}
                        onMarkAllRead={link.contextMenu.onMarkAllRead}
                        onConfigureLabels={link.contextMenu.onConfigureLabels}
                        onAddLabel={link.contextMenu.onAddLabel}
                        onDeleteLabel={link.contextMenu.onDeleteLabel}
                        onAddSource={link.contextMenu.onAddSource}
                        onAddSkill={link.contextMenu.onAddSkill}
                        onAddAutomation={link.contextMenu.onAddAutomation}
                        onAddProject={link.contextMenu.onAddProject}
                        sourceType={link.contextMenu.sourceType}
                        onConfigureViews={link.contextMenu.onConfigureViews}
                        viewId={link.contextMenu.viewId}
                        onDeleteView={link.contextMenu.onDeleteView}
                      />
                    </ContextMenuProvider>
                  </StyledContextMenuContent>
                </ContextMenu>
              ) : (
                buttonElement
              )}
              {/* Expandable subitems — outside context menu scope so only the
                * clicked button gets data-state="open", not nested children */}
              {link.expandable && link.items && (
                <AnimatePresence initial={false}>
                  {link.expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      animate={{ height: 'auto', opacity: 1, marginTop: 2, marginBottom: isNested ? 4 : 8 }}
                      exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      {expandedContent}
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          )

          // For nested items, wrap in motion.div for stagger animation
          return isNested ? (
            <motion.div key={link.id} variants={itemVariants}>
              {content}
            </motion.div>
          ) : (
            <React.Fragment key={link.id}>
              {content}
            </React.Fragment>
          )
        })}
      </NavWrapper>
    </div>
  )
}

// ============================================================
// Expanded Content Renderer
// Chooses between sortable, sortableTree, or regular nested sidebar
// ============================================================

function renderExpandedContent(
  link: LinkItem,
  getItemProps: LeftSidebarProps['getItemProps'],
  focusedItemId: string | null | undefined,
  isNested: boolean | undefined
): React.ReactNode {
  // Flat sortable (e.g., statuses): wrap items in SortableList
  if (link.sortable && link.items) {
    // Split at first separator: items before are sortable, items after are trailing (non-sortable)
    const separatorIndex = link.items.findIndex(isSeparatorItem)
    const sortableItems = separatorIndex >= 0 ? link.items.slice(0, separatorIndex) : link.items
    const trailingItems = separatorIndex >= 0
      ? link.items.slice(separatorIndex + 1).filter((item): item is LinkItem => !isSeparatorItem(item))
      : []

    return (
      <SortableStatusList
        items={sortableItems}
        onReorder={link.sortable.onReorder}
        getItemProps={getItemProps}
        focusedItemId={focusedItemId}
        trailingItems={trailingItems.length > 0 ? trailingItems : undefined}
      />
    )
  }

  // Default: regular nested sidebar (no DnD)
  return (
    <LeftSidebar
      isCollapsed={false}
      isNested={true}
      getItemProps={getItemProps}
      focusedItemId={focusedItemId}
      links={link.items!}
    />
  )
}
