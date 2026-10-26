import * as React from 'react';
import { ChevronDown, Check } from 'lucide-react';

import { cn } from '@/lib/utils';

import { ANTHROPIC_MODELS, getModelShortName } from '@config/models';

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { KanbanModelProviderGroup } from './types';

export const GENERATE_CLIENT_TIMEOUT_MS = 200_000

export const FALLBACK_MODEL_GROUPS: KanbanModelProviderGroup[] = [
  { provider: 'anthropic', label: 'Anthropic', models: ANTHROPIC_MODELS.map((m) => ({ id: m.id, name: m.name })) },
]

export function resolveModelName(groups: KanbanModelProviderGroup[], id: string): string {
  for (const g of groups) {
    const hit = g.models.find((m) => m.id === id)
    if (hit) return hit.name
  }
  return getModelShortName(id)
}

export type Mode = 'generate' | 'manual'

export type Tab = 'definition' | 'results'

export type TaskResults = Awaited<ReturnType<typeof window.electronAPI.getTaskResults>>

export type BtnVariant = 'primary' | 'secondary' | 'ghost'

export const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-indigo-500 text-white hover:bg-indigo-600',
  secondary: 'border border-border bg-card text-foreground hover:bg-foreground/[0.03]',
  ghost: 'text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground',
}

export function Btn({
  variant = 'secondary',
  className,
  ...rest
}: { variant?: BtnVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12.5px] font-semibold transition-colors',
        'disabled:pointer-events-none disabled:opacity-60',
        BTN_VARIANT[variant],
        className,
      )}
      {...rest}
    />
  )
}

export const SelectButton = React.forwardRef<
  HTMLButtonElement,
  { size?: 'sm' | 'md' } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function SelectButton({ size = 'md', children, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background font-medium text-foreground',
        'transition-colors hover:bg-foreground/[0.03] data-[state=open]:bg-foreground/[0.03]',
        size === 'sm' ? 'h-7 px-2 text-[11.5px]' : 'h-8 px-2.5 text-[12.5px]',
        className,
      )}
      {...rest}
    >
      {children}
      <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground/40" strokeWidth={2} />
    </button>
  )
})

export function ModelSelect({
  value,
  onChange,
  groups,
  width = 168,
  size = 'md',
}: {
  value: string
  onChange: (id: string) => void
  groups: KanbanModelProviderGroup[]
  width?: number
  size?: 'sm' | 'md'
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SelectButton size={size} style={{ width }}>
          <span className="truncate">{resolveModelName(groups, value)}</span>
        </SelectButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] min-w-[180px]">
        {groups.map((g, gi) => (
          <React.Fragment key={`${g.provider}-${gi}`}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[11px] text-foreground/50">{g.label}</DropdownMenuLabel>
            {g.models.map((m) => (
              <DropdownMenuItem key={m.id} className="text-xs" onSelect={() => onChange(m.id)}>
                <span className="truncate">{m.name}</span>
                {m.id === value && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] font-medium text-foreground/55">{label}</span>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
