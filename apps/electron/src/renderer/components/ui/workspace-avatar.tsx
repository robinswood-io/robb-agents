/**
 * WorkspaceAvatar - Thin wrapper around CrossfadeAvatar for workspace icons.
 *
 * When no icon is set, renders a deterministic colored initial-letter fallback
 * derived from the workspace ID (so the same workspace always gets the same
 * color across sessions and across surfaces).
 *
 * Sizing/shape is fully controlled by `className` (e.g. `h-4 w-4 rounded-full`).
 */


import { useAtomValue } from 'jotai'
import { CrossfadeAvatar } from './avatar'
import { cn } from '@/lib/utils'
import { workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
  }
  return Math.abs(hash)
}

function getWorkspaceHue(id: string): number {
  return hashString(id) % 360
}

interface WorkspaceAvatarProps {
  /** Workspace id. If omitted, the fallback uses a neutral muted background. */
  workspaceId?: string | undefined
  workspaceName?: string | undefined
  src?: string | null | undefined
  className?: string | undefined
  /** Override font size for the initial letter (default `text-[10px]`). */
  fallbackClassName?: string | undefined
}

export function WorkspaceAvatar({
  workspaceId,
  workspaceName,
  src,
  className,
  fallbackClassName,
}: WorkspaceAvatarProps) {
  const colorOverrides = useAtomValue(workspaceAvatarColorsAtom)
  const initial = (workspaceName?.trim().charAt(0) || 'W').toUpperCase()
  const hasId = !!workspaceId
  const override = hasId ? colorOverrides[workspaceId!] : undefined
  const bgStyle = hasId
    ? {
        backgroundColor:
          override || `hsl(${getWorkspaceHue(workspaceId!)}, 45%, 52%)`,
      }
    : undefined

  return (
    <CrossfadeAvatar
      src={src ?? undefined}
      alt={workspaceName}
      className={className}
      fallbackClassName={cn('text-[10px]', !hasId && 'bg-muted', fallbackClassName)}
      fallback={
        hasId ? (
          <div
            className="flex h-full w-full items-center justify-center font-medium text-white"
            style={bgStyle}
          >
            {initial}
          </div>
        ) : (
          initial
        )
      }
    />
  )
}
