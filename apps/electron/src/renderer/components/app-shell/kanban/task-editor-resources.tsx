import * as React from 'react';
import { DatabaseZap, Zap, Folder } from 'lucide-react';

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

import { SourceAvatar } from '@/components/ui/source-avatar';
import { SkillAvatar } from '@/components/ui/skill-avatar';
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover';
import { SkillSelectorPopover } from '@/components/ui/SkillSelectorPopover';
import { WorkingDirectorySelector } from '../input/WorkingDirectorySelector';
import type { LoadedSource, LoadedSkill } from '../../../../shared/types';
import { SelectButton } from "./task-editor-primitives";

export function AvatarStack({ avatars }: { avatars: React.ReactNode[] }) {
  const display = avatars.slice(0, 3)
  const remaining = avatars.length - 3
  return (
    <div className="-ml-0.5 flex shrink-0 items-center">
      {display.map((node, i) => (
        <div
          key={i}
          className={cn(
            'relative flex h-5 w-5 items-center justify-center rounded-[4px] bg-background shadow-minimal',
            i > 0 && '-ml-1',
          )}
          style={{ zIndex: i + 1 }}
        >
          {node}
        </div>
      ))}
      {remaining > 0 && (
        <div
          className="-ml-1 flex h-5 w-5 items-center justify-center rounded-[4px] bg-background text-[8px] font-medium text-muted-foreground shadow-minimal"
          style={{ zIndex: display.length + 1 }}
        >
          +{remaining}
        </div>
      )}
    </div>
  )
}

export function SourcesField({
  sources,
  values,
  onChange,
  title,
}: {
  sources: LoadedSource[]
  values: string[]
  onChange: (next: string[]) => void
  title?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const anchorRef = React.useRef<HTMLButtonElement>(null)
  const selected = values
    .map((slug) => sources.find((s) => s.config.slug === slug))
    .filter((s): s is LoadedSource => Boolean(s))
  const firstName = selected[0]?.config.name ?? values[0]
  const label =
    values.length === 0 ? t('tasks.noneSelected') : values.length === 1 ? firstName : `${firstName} +${values.length - 1}`
  const toggle = (slug: string) =>
    onChange(values.includes(slug) ? values.filter((v) => v !== slug) : [...values, slug])
  return (
    <>
      <SelectButton
        ref={anchorRef}
        style={{ width: 168 }}
        title={title}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected.length === 0 ? (
          <DatabaseZap className="h-4 w-4 shrink-0 text-foreground/40" strokeWidth={2} />
        ) : (
          <AvatarStack avatars={selected.map((s) => <SourceAvatar key={s.config.slug} source={s} size="xs" />)} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-left', values.length === 0 && 'text-foreground/50')}>{label}</span>
      </SelectButton>
      <SourceSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        sources={sources}
        selectedSlugs={values}
        onToggleSlug={toggle}
      />
    </>
  )
}

export function SkillsField({
  skills,
  values,
  onChange,
  workspaceId,
  title,
}: {
  skills: LoadedSkill[]
  values: string[]
  onChange: (next: string[]) => void
  workspaceId: string
  title?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const anchorRef = React.useRef<HTMLButtonElement>(null)
  const selected = values
    .map((slug) => skills.find((s) => s.slug === slug))
    .filter((s): s is LoadedSkill => Boolean(s))
  const firstName = selected[0]?.metadata.name ?? values[0]
  const label =
    values.length === 0 ? t('tasks.noneSelected') : values.length === 1 ? firstName : `${firstName} +${values.length - 1}`
  const toggle = (slug: string) =>
    onChange(values.includes(slug) ? values.filter((v) => v !== slug) : [...values, slug])
  return (
    <>
      <SelectButton
        ref={anchorRef}
        style={{ width: 168 }}
        title={title}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected.length === 0 ? (
          <Zap className="h-4 w-4 shrink-0 text-foreground/40" strokeWidth={2} />
        ) : (
          <AvatarStack avatars={selected.map((s) => <SkillAvatar key={s.slug} skill={s} size="xs" workspaceId={workspaceId} />)} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-left', values.length === 0 && 'text-foreground/50')}>{label}</span>
      </SelectButton>
      <SkillSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        skills={skills}
        selectedSlugs={values}
        onToggleSlug={toggle}
        workspaceId={workspaceId}
      />
    </>
  )
}

export function FolderField({
  cwd,
  onChange,
  workspaceId,
}: {
  cwd: string
  onChange: (path: string) => void
  workspaceId: string
}) {
  const { t } = useTranslation()
  return (
    <WorkingDirectorySelector
      workingDirectory={cwd || undefined}
      onWorkingDirectoryChange={onChange}
      workspaceId={workspaceId}
      side="bottom"
      align="start"
      renderTrigger={({ hasFolder, folderName }) => (
        <SelectButton style={{ width: 168 }} title={t('tasks.workingDirectoryHint')}>
          <Folder className="h-3.5 w-3.5 shrink-0 text-foreground/40" strokeWidth={2} />
          <span className={cn('min-w-0 flex-1 truncate text-left', !hasFolder && 'text-foreground/50')}>
            {folderName ?? t('chat.workInFolder')}
          </span>
        </SelectButton>
      )}
    />
  )
}
