/**
 * SkillAvatar - Thin wrapper around EntityIcon for skills.
 *
 * Sets fallbackIcon={Zap} and delegates all rendering to EntityIcon.
 * Use `fluid` prop for fill-parent sizing (e.g., Info_Page.Hero).
 */

import { Zap } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'
import type { LoadedSkill } from '../../../shared/types'

interface SkillAvatarProps {
  /** LoadedSkill object */
  skill: LoadedSkill
  /** Size variant */
  size?: IconSize | undefined
  /** Fill parent container (h-full w-full). Overrides size. */
  fluid?: boolean | undefined
  /** Additional className overrides */
  className?: string | undefined
  /** Workspace ID for loading local icons */
  workspaceId?: string | undefined
}

export function SkillAvatar({ skill, size = 'md', fluid, className, workspaceId }: SkillAvatarProps) {
  const icon = useEntityIcon({
    workspaceId: workspaceId ?? '',
    entityType: 'skill',
    identifier: skill.slug,
    ...(skill.iconPath !== undefined ? { iconPath: skill.iconPath } : {}),
    ...(skill.metadata.icon !== undefined ? { iconValue: skill.metadata.icon } : {}),
  })

  return (
    <EntityIcon
      icon={icon}
      size={size}
      fallbackIcon={Zap}
      alt={skill.metadata.name}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )
}
