import * as React from 'react';










/** Window the long-press / right-click handler keeps `suppressNextActivation`
 *  asserted for after the drawer opens. Activation events (`onMouseDown` /
 *  `onClick`) within this window are dropped so the row doesn't get selected
 *  underneath the drawer when the user releases the press. A normal tap is
 *  <300ms, so the window doesn't eat real taps. */
export const SUPPRESS_ACTIVATION_MS = 300


export interface EntityRowProps {
  /** Left icon area — rendered in-flow as a flex child before the content column.
   *  Consumers can pass multiple icons (e.g. via a fragment) for a horizontal icon group. */
  icon?: React.ReactNode | undefined
  /** Title content (ReactNode for search highlighting support) */
  title: React.ReactNode
  /** Additional className on the title wrapper (e.g. shimmer animation) */
  titleClassName?: string | undefined
  /** Content rendered inline after the title (e.g. timestamp). On hover, swapped with the more button.
   *  When set, the title row becomes single-line (truncated) and the absolute more button is hidden. */
  titleTrailing?: React.ReactNode | undefined
  /** Content rendered inline immediately after the title, on the same row.
   *  Lives between the title and the trailing slot. Use for tiny, high-priority
   *  inline chips (e.g. platform bindings) that should read as part of the title
   *  area, not as badges below. `shrink-0` so long titles truncate first. */
  titleSuffix?: React.ReactNode | undefined
  /** Optional subtitle line beneath the title */
  subtitle?: React.ReactNode | undefined
  /** Badge/subtitle row beneath the title */
  badges?: React.ReactNode | undefined
  /** Right-aligned content in the badge row (timestamp, child toggle) */
  trailing?: React.ReactNode | undefined
  /** Content rendered below the main button (e.g. expanded child list) */
  children?: React.ReactNode | undefined
  /** Absolutely-positioned overlay (e.g. match count badge) */
  overlay?: React.ReactNode | undefined

  // --- Interaction ---
  /** Selection state */
  isSelected?: boolean | undefined
  /** Multi-select highlight (left accent bar + tinted bg) */
  isInMultiSelect?: boolean | undefined
  /** Suppress the left-edge selection bar (background tint still shows). Used
   *  when an outer wrapper draws its own accent stripe (e.g. project color) at
   *  the same leading edge and the two would collide. */
  suppressSelectionBar?: boolean | undefined
  /** Click handler — use onMouseDown for modifier key detection (Session), or onClick for simple cases */
  onMouseDown?: ((e: React.MouseEvent) => void) | undefined
  /** Simple click handler (used when modifier key detection isn't needed) */
  onClick?: (() => void) | undefined
  /** Show separator above this row */
  showSeparator?: boolean | undefined

  // --- Menu ---
  /** Menu content — rendered in BOTH dropdown and context menu via providers.
   *  Should be a component that uses useMenuComponents() for its items. */
  menuContent?: React.ReactNode | undefined
  /** Context menu content when different from dropdown (e.g. batch menu in multi-select) */
  contextMenuContent?: React.ReactNode | undefined
  /** Whether to hide the more button (e.g. when overlay is showing) */
  hideMoreButton?: boolean | undefined
  /** Whether to render the menu surface in compact (drawer) mode. Pass-through
   *  from the consumer so EntityRow stays generic and usable from playground /
   *  non-AppShell surfaces. Only meaningful in combination with `compactMenu`. */
  isCompactMode?: boolean | undefined
  /** Render-prop for the compact (drawer) menu surface. EntityRow owns the
   *  open state (driven by both the `…` button and long-press / right-click)
   *  and hands it to the consumer so a single drawer instance is controlled
   *  by both triggers. When omitted OR `isCompactMode` is false: the
   *  existing dropdown/context-menu behaviour kicks in. */
  compactMenu?: ((props: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => React.ReactNode) | undefined

  // --- Passthrough ---
  /** Additional props spread onto the <button> (aria attrs, keyboard handlers, tabIndex, ref) */
  buttonProps?: Record<string, unknown> | undefined
  /** Data attributes on the outer wrapper div */
  dataAttributes?: Record<string, string | undefined> | undefined
  /** Outer wrapper className */
  className?: string | undefined
  /** Separator padding class (default: 'pl-12 pr-4') */
  separatorClassName?: string | undefined
}
