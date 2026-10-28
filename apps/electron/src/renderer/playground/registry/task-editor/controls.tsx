import * as React from "react";
import { ChevronDown, Trash2, GripVertical, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { EditorSubtask } from "./fixtures";
import { modelDot, modelName, MODELS } from "./fixtures";

export function YamlLine({ line }: { line: string }) {
  if (line.trim().startsWith('#'))
    return <div className="text-foreground/35">{line || ' '}</div>
  const m = line.match(/^(\s*-?\s*)([\w.-]+:)(.*)$/)
  if (m) {
    const [, lead = '', key = '', rest = ''] = m
    const cm = rest.indexOf(' #')
    const value = cm >= 0 ? rest.slice(0, cm) : rest
    const comment = cm >= 0 ? rest.slice(cm) : ''
    return (
      <div>
        <span>{lead}</span>
        <span className="text-indigo-500 dark:text-indigo-300">{key}</span>
        <span className="text-foreground/80">{value}</span>
        {comment && <span className="text-foreground/30">{comment}</span>}
      </div>
    )
  }
  return <div className="text-foreground/75">{line || ' '}</div>
}

// ---------------------------------------------------------------------------
// Small inline controls
// ---------------------------------------------------------------------------
// Unified button system — one radius (rounded-lg), one height per size, a small
// set of variants. Every actionable button routes through this so heights /
// radii / hover states can't drift apart (the previous editor hand-rolled ~8).
type BtnVariant = 'primary' | 'secondary' | 'ghost'

type BtnSize = 'sm' | 'md' | 'lg'

const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8 px-3 text-[12.5px]',
  lg: 'h-11 px-4 text-[13.5px]',
}

const BTN_VARIANT: Record<BtnVariant, string> = {
  // Solid indigo = the single commit action ("Prepare task").
  primary: 'bg-indigo-500 text-white hover:bg-indigo-600',
  // Neutral outline = quiet secondary (Save draft, Add subtask).
  secondary: 'border border-border bg-card text-foreground hover:bg-foreground/[0.03]',
  // Borderless = lowest emphasis (Board back link).
  ghost: 'text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground',
}

export function Btn({
  variant = 'secondary',
  size = 'md',
  block = false,
  className,
  ...rest
}: { variant?: BtnVariant | undefined; size?: BtnSize | undefined; block?: boolean | undefined } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors',
        'disabled:pointer-events-none disabled:opacity-60',
        BTN_SIZE[size],
        BTN_VARIANT[variant],
        block && 'w-full',
        className
      )}
      {...rest}
    />
  )
}

// A dropdown/popover trigger styled as a consistent "select" pill. `sm` for the
// dense subtask rows, `md` for the left-column field selects.
export function SelectButton({
  size = 'md',
  children,
  className,
  ...rest
}: { size?: 'sm' | 'md' | undefined } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background font-medium text-foreground',
        'transition-colors hover:bg-foreground/[0.03] data-[state=open]:bg-foreground/[0.03]',
        size === 'sm' ? 'h-7 px-2 text-[11.5px]' : 'h-8 px-2.5 text-[12.5px]',
        className
      )}
      {...rest}
    >
      {children}
      <ChevronDown
        className={cn('ml-auto shrink-0 text-foreground/40', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')}
        strokeWidth={2}
      />
    </button>
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

export function ModelSelect({ value, onChange, width = 168, size = 'md' }: { value: string; onChange: (id: string) => void; width?: number | undefined; size?: 'sm' | 'md' | undefined }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SelectButton size={size} style={{ width }}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: modelDot(value) }} />
          <span className="truncate">{modelName(value)}</span>
        </SelectButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        {MODELS.map(m => (
          <DropdownMenuItem key={m.id} className="text-xs" onSelect={() => onChange(m.id)}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: m.dot }} />
            <span className="truncate">{m.name}</span>
            {m.id === value && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Subtask card
// ---------------------------------------------------------------------------
export function SubtaskCard({
  index,
  subtask,
  earlier,
  onChange,
  onRemove,
}: {
  index: number
  subtask: EditorSubtask
  earlier: EditorSubtask[]
  onChange: (patch: Partial<EditorSubtask>) => void
  onRemove: () => void
}) {
  const depTitle = subtask.dependsOn ? earlier.find(s => s.id === subtask.dependsOn)?.title : null
  return (
    <div className="group rounded-[10px] border border-border/70 bg-foreground/[0.015] p-3">
      <div className="flex items-start gap-2">
        {/* Drag handle on the left edge — the conventional reorder affordance. */}
        <GripVertical
          className="mt-1 h-4 w-4 shrink-0 cursor-grab text-foreground/20 transition-colors group-hover:text-foreground/40"
          strokeWidth={2}
          aria-hidden
        />
        <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-500/10 text-[12px] font-bold text-indigo-500 dark:text-indigo-300">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={subtask.title}
            onChange={e => onChange({ title: e.target.value })}
            placeholder="Subtask title…"
            className="w-full bg-transparent text-[13.5px] font-semibold text-foreground outline-none placeholder:text-foreground/30"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ModelSelect value={subtask.model} onChange={id => onChange({ model: id })} width={128} size="sm" />
            {/* dependency picker — same select shape as the model picker */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SelectButton size="sm" style={{ width: 168 }}>
                  <span className="truncate text-foreground/70">
                    {depTitle ? `depends on: ${depTitle}` : 'no dependency'}
                  </span>
                </SelectButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[240px]">
                <DropdownMenuItem className="text-xs" onSelect={() => onChange({ dependsOn: null })}>
                  No dependency
                  {!subtask.dependsOn && <Check className="ml-auto h-3.5 w-3.5" strokeWidth={2} />}
                </DropdownMenuItem>
                {earlier.map(e => (
                  <DropdownMenuItem key={e.id} className="text-xs" onSelect={() => onChange({ dependsOn: e.id })}>
                    <span className="truncate">{e.title || 'Untitled subtask'}</span>
                    {subtask.dependsOn === e.id && <Check className="ml-auto h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
                  </DropdownMenuItem>
                ))}
                {earlier.length === 0 && (
                  <div className="px-2 py-1.5 text-[11px] text-foreground/40">No earlier subtasks</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* Delete stays hover-reveal to keep the row calm. */}
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove subtask"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
