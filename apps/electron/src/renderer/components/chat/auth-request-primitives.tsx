

import { type LucideIcon } from 'lucide-react';
import { Spinner } from '@craft-agent/ui';
import { Button } from '@/components/ui/button';

import { cn } from '@/lib/utils';

export type AuthCardVariant = 'default' | 'success' | 'error' | 'muted'

export const VARIANT_STYLES: Record<AuthCardVariant, { bg: string; textClass: string; shadowColor?: string }> = {
  default: { bg: 'var(--background)', textClass: 'text-foreground shadow-minimal' },
  success: { bg: 'oklch(from var(--success) l c h / 0.03)', textClass: 'text-[var(--success-text)] shadow-tinted', shadowColor: 'var(--success-rgb)' },
  error: { bg: 'oklch(from var(--destructive) l c h / 0.03)', textClass: 'text-[var(--destructive-text)] shadow-tinted', shadowColor: 'var(--destructive-rgb)' },
  muted: { bg: 'var(--foreground-3)', textClass: 'text-foreground/70 shadow-minimal' },
}

export interface AuthCardHeaderProps {
  icon?: LucideIcon | undefined
  iconClassName?: string | undefined
  title: string
  titleSuffix?: string | undefined
  subtitle?: string | undefined
  subtitleSecondary?: string | undefined
  description?: string | undefined
}

export function AuthCardHeader({
  icon: Icon,
  iconClassName,
  title,
  titleSuffix,
  subtitle,
  subtitleSecondary,
  description,
}: AuthCardHeaderProps) {
  return (
    <div className="flex gap-3">
      {/* Icon aligned to first line of text (optional) */}
      {Icon && <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', iconClassName)} />}
      <div className="flex-1 min-w-0">
        {/* Title inherits container text color */}
        <div className="text-sm font-medium leading-5">
          {title}
          {titleSuffix && (
            <span className="text-xs text-muted-foreground ml-2">({titleSuffix})</span>
          )}
        </div>
        {/* Subtitles use 50% opacity of inherited color */}
        {subtitle && (
          <div className="text-xs mt-0.5 opacity-50">
            {subtitle}
          </div>
        )}
        {subtitleSecondary && (
          <div className="text-xs mt-0.5 opacity-50">
            {subtitleSecondary}
          </div>
        )}
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
    </div>
  )
}

export interface AuthCardActionsProps {
  primary: {
    label: string
    icon?: LucideIcon
    onClick: () => void
    disabled?: boolean
    loading?: boolean
    dataTutorial?: string
  }
  secondary?: {
    label: string
    icon?: LucideIcon
    onClick: () => void
    disabled?: boolean
  } | undefined
  hint?: string | undefined
}

export function AuthCardActions({ primary, secondary, hint }: AuthCardActionsProps) {
  const PrimaryIcon = primary.icon
  const SecondaryIcon = secondary?.icon

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
      <Button
        size="sm"
        variant="default"
        className="h-7 gap-1.5"
        onClick={primary.onClick}
        disabled={primary.disabled}
        data-tutorial={primary.dataTutorial}
      >
        {primary.loading ? (
          <Spinner className="text-[10px]" />
        ) : PrimaryIcon ? (
          <PrimaryIcon className="h-3.5 w-3.5" />
        ) : null}
        {primary.label}
      </Button>
      {secondary && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={secondary.onClick}
          disabled={secondary.disabled}
        >
          {SecondaryIcon && <SecondaryIcon className="h-3.5 w-3.5" />}
          {secondary.label}
        </Button>
      )}
      {hint && (
        <>
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        </>
      )}
    </div>
  )
}
