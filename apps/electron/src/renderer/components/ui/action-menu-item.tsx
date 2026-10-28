import { useActionLabel } from '@/actions'
import { StyledDropdownMenuItem } from './styled-dropdown'
import type { ActionId } from '@/actions/definitions'

interface ActionMenuItemProps {
  action: ActionId
  onClick?: (() => void) | undefined
  children?: React.ReactNode | undefined
}

export function ActionMenuItem({ action, onClick, children }: ActionMenuItemProps) {
  const { label, hotkey } = useActionLabel(action)

  return (
    <StyledDropdownMenuItem onClick={onClick}>
      <span>{children || label}</span>
      {hotkey && (
        <span className="ml-auto text-xs text-muted-foreground">{hotkey}</span>
      )}
    </StyledDropdownMenuItem>
  )
}
