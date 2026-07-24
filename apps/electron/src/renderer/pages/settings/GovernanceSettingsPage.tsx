import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { verifyGovernanceAuditInBrowser, type GovernanceAuditVerification } from '@/lib/governance-audit'
import type { SpaceRole, WorkspaceGovernanceProfile } from '@craft-agent/shared/governance'
import type {
  RemoteAction,
  RemoteSupervisionProfile,
  RemoteSyncField,
} from '@craft-agent/shared/remote-supervision'

const SPACE_ROLES = ['owner', 'admin', 'operator', 'validator', 'reader'] as const satisfies readonly SpaceRole[]
const REMOTE_SYNC_FIELDS = [
  'task.status',
  'task.progress',
  'task.blockers',
  'task.approvals',
  'task.cost',
  'task.timestamps',
] as const satisfies readonly RemoteSyncField[]
const REMOTE_ACTIONS = [
  'task.pause',
  'task.cancel',
  'approval.resolve',
] as const satisfies readonly RemoteAction[]
const DEFAULT_REMOTE_FIELDS: RemoteSyncField[] = [
  'task.status',
  'task.progress',
  'task.blockers',
  'task.approvals',
]
const DEFAULT_REMOTE_ACTIONS: RemoteAction[] = [
  'task.pause',
  'task.cancel',
  'approval.resolve',
]

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'governance',
}

function optionalPositiveNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function isSpaceRole(value: string): value is SpaceRole {
  return SPACE_ROLES.some((candidate) => candidate === value)
}

export default function GovernanceSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const [resolvedWorkspaces, setResolvedWorkspaces] = useState(workspaces)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId)
  const [profile, setProfile] = useState<WorkspaceGovernanceProfile | null>(null)
  const [governanceRevision, setGovernanceRevision] = useState(0)
  const [governanceUpdatedAt, setGovernanceUpdatedAt] = useState<string | null>(null)
  const [governanceUpdatedBy, setGovernanceUpdatedBy] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [newActorId, setNewActorId] = useState('')
  const [newActorRole, setNewActorRole] = useState<SpaceRole>('reader')
  const [auditVerification, setAuditVerification] = useState<GovernanceAuditVerification>({ valid: true })
  const [remoteProfile, setRemoteProfile] = useState<RemoteSupervisionProfile | null>(null)
  const [remoteFields, setRemoteFields] = useState<RemoteSyncField[]>(DEFAULT_REMOTE_FIELDS)
  const [remoteActions, setRemoteActions] = useState<RemoteAction[]>(DEFAULT_REMOTE_ACTIONS)
  const [remotePurpose, setRemotePurpose] = useState(() =>
    t('settings.governance.remoteDefaultPurpose', 'Operational supervision'))
  const [remoteExpiryHours, setRemoteExpiryHours] = useState('24')
  const [isRemoteSaving, setIsRemoteSaving] = useState(false)
  const selectableWorkspaces = workspaces.length > 0 ? workspaces : resolvedWorkspaces
  const workspaceId = selectedWorkspaceId ?? activeWorkspaceId ?? selectableWorkspaces[0]?.id ?? null
  const activeRemoteConsent = remoteProfile?.state.mode === 'remote-metadata'
    && remoteProfile.state.consent
    && Date.parse(remoteProfile.state.consent.expiresAt) > Date.now()
    ? remoteProfile.state.consent
    : null

  useEffect(() => {
    if (workspaces.length > 0) {
      setResolvedWorkspaces(workspaces)
      return
    }
    if (!window.electronAPI) return
    void window.electronAPI.getWorkspaces().then(setResolvedWorkspaces).catch((error: unknown) => {
      console.error('Failed to resolve governance workspaces:', error)
    })
  }, [workspaces])

  useEffect(() => {
    if (activeWorkspaceId) {
      setSelectedWorkspaceId(activeWorkspaceId)
      return
    }
    setSelectedWorkspaceId((current) => current ?? selectableWorkspaces[0]?.id ?? null)
  }, [activeWorkspaceId, selectableWorkspaces])

  const load = useCallback(async () => {
    if (!workspaceId || !window.electronAPI) {
      setProfile(null)
      setGovernanceRevision(0)
      setGovernanceUpdatedAt(null)
      setGovernanceUpdatedBy(null)
      setRemoteProfile(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const settings = await window.electronAPI.getWorkspaceSettings(workspaceId)
      setProfile(settings?.governance ?? null)
      setGovernanceRevision(settings?.governanceRevision ?? 0)
      setGovernanceUpdatedAt(settings?.governanceUpdatedAt ?? null)
      setGovernanceUpdatedBy(settings?.governanceUpdatedBy ?? null)
      const supervision = settings?.remoteSupervision ?? null
      setRemoteProfile(supervision)
      if (supervision?.state.consent) {
        setRemoteFields([...supervision.state.consent.fields])
        setRemoteActions([...supervision.state.consent.actions])
        setRemotePurpose(supervision.state.consent.purpose)
      } else {
        setRemoteFields(DEFAULT_REMOTE_FIELDS)
        setRemoteActions(DEFAULT_REMOTE_ACTIONS)
        setRemotePurpose(t('settings.governance.remoteDefaultPurpose', 'Operational supervision'))
      }
    } catch (error) {
      console.error('Failed to load workspace governance:', error)
      toast.error(t('settings.governance.loadFailed', 'Unable to load governance settings'))
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId, t])

  const toggleRemoteField = useCallback((field: RemoteSyncField) => {
    setRemoteFields((current) => current.includes(field)
      ? current.filter((candidate) => candidate !== field)
      : [...current, field])
  }, [])

  const toggleRemoteAction = useCallback((action: RemoteAction) => {
    setRemoteActions((current) => current.includes(action)
      ? current.filter((candidate) => candidate !== action)
      : [...current, action])
  }, [])

  const handleRemoteSupervisionChange = useCallback(async (enabled: boolean) => {
    if (!workspaceId || !window.electronAPI) return
    setIsRemoteSaving(true)
    try {
      if (enabled) {
        if (remoteFields.length === 0) {
          throw new Error(t('settings.governance.remoteFieldRequired', 'Select at least one metadata field.'))
        }
        if (remoteActions.length === 0) {
          throw new Error(t('settings.governance.remoteActionRequired', 'Select at least one remote action.'))
        }
        const purpose = remotePurpose.trim()
        if (!purpose) {
          throw new Error(t('settings.governance.remotePurposeRequired', 'Describe the purpose of this access.'))
        }
        const expiryHours = Number(remoteExpiryHours)
        if (!Number.isFinite(expiryHours) || expiryHours < 1 || expiryHours > 720) {
          throw new Error(t('settings.governance.remoteExpiryInvalid', 'Expiry must be between 1 and 720 hours.'))
        }
        const next = await window.electronAPI.grantRemoteSupervision(workspaceId, {
          fields: remoteFields,
          actions: remoteActions,
          purpose,
          expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1_000).toISOString(),
        })
        setRemoteProfile(next)
        toast.success(t('settings.governance.remoteSaved', 'Remote supervision consent recorded'))
      } else {
        const next = await window.electronAPI.revokeRemoteSupervision(workspaceId, {
          reason: t('settings.governance.remoteRevocationReason', 'Revoked from governance settings'),
        })
        setRemoteProfile(next)
        toast.success(t('settings.governance.remoteRevoked', 'Remote supervision revoked'))
      }
    } catch (error) {
      console.error('Failed to update remote supervision:', error)
      toast.error(error instanceof Error
        ? error.message
        : t('settings.governance.remoteSaveFailed', 'Unable to update remote supervision'))
    } finally {
      setIsRemoteSaving(false)
    }
  }, [
    remoteActions,
    remoteExpiryHours,
    remoteFields,
    remotePurpose,
    t,
    workspaceId,
  ])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (next: WorkspaceGovernanceProfile) => {
    if (!workspaceId || !window.electronAPI) return
    setIsSaving(true)
    try {
      const result = await window.electronAPI.updateWorkspaceGovernance(workspaceId, {
        expectedRevision: governanceRevision,
        actorId: next.space.createdBy,
        profile: next,
      })
      setProfile(result.governance)
      setGovernanceRevision(result.governanceRevision)
      setGovernanceUpdatedAt(result.governanceUpdatedAt)
      setGovernanceUpdatedBy(result.governanceUpdatedBy)
      toast.success(t('settings.governance.saved', 'Governance policy saved'))
    } catch (error) {
      console.error('Failed to save workspace governance:', error)
      const message = error instanceof Error ? error.message : ''
      if (message.toLowerCase().includes('governance revision conflict')) {
        await load()
        toast.error(t(
          'settings.governance.conflict',
          'Governance changed in another client. The latest revision has been loaded.',
        ))
      } else {
        toast.error(message || t('settings.governance.saveFailed', 'Unable to save governance settings'))
      }
    } finally {
      setIsSaving(false)
    }
  }, [governanceRevision, load, workspaceId, t])

  useEffect(() => {
    let active = true
    void verifyGovernanceAuditInBrowser(profile?.audit ?? []).then((verification) => {
      if (active) setAuditVerification(verification)
    }).catch((error: unknown) => {
      console.error('Failed to verify governance audit:', error)
      if (active) setAuditVerification({ valid: false })
    })
    return () => {
      active = false
    }
  }, [profile?.audit])

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t('settings.governance.title', 'Governance')} />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.governance.title', 'Governance')}
        actions={<HeaderMenu route={routes.view.settings('governance')} helpFeature="permissions" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
            {selectableWorkspaces.length > 1 && (
              <SettingsCard className="p-4">
                <label className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium">
                    {t('settings.governance.workspace', 'Workspace')}
                  </span>
                  <select
                    value={workspaceId ?? ''}
                    disabled={isSaving}
                    aria-label={t('settings.governance.workspace', 'Workspace')}
                    onChange={(event) => setSelectedWorkspaceId(event.target.value || null)}
                    className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    {selectableWorkspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                    ))}
                  </select>
                </label>
              </SettingsCard>
            )}
            {!profile ? (
              <SettingsCard className="p-5 text-sm text-muted-foreground">
                {t('settings.governance.noWorkspace', 'Select a workspace to configure governance.')}
              </SettingsCard>
            ) : (
              <>
                <SettingsCard className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">
                        {t('settings.governance.sharedStore', 'Shared governance store')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t(
                          'settings.governance.sharedStoreDesc',
                          'Atomic workspace policy shared by desktop and server clients with conflict detection.',
                        )}
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>
                        {t('settings.governance.revision', 'Revision {{revision}}', {
                          revision: governanceRevision,
                        })}
                      </div>
                      {governanceUpdatedAt && (
                        <div>
                          {t('settings.governance.updatedBy', 'Updated {{date}} by {{actor}}', {
                            date: new Date(governanceUpdatedAt).toLocaleString(),
                            actor: governanceUpdatedBy ?? profile.space.createdBy,
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </SettingsCard>

                <SettingsSection
                  title={t('settings.governance.members', 'Members and roles')}
                  description={t('settings.governance.membersDesc', 'Owner, admin, operator, validator, and reader access is enforced per workspace.')}
                >
                  <SettingsCard>
                    {profile.space.members.map((member) => {
                      const isLocalOwner = member.actorId === profile.space.createdBy
                      return (
                        <div key={member.actorId} className="flex items-center gap-3 px-4 py-3 border-b border-border/60 last:border-b-0">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{member.actorId}</div>
                            <div className="text-xs text-muted-foreground">
                              {isLocalOwner
                                ? t('settings.governance.localOwner', 'Local workspace owner')
                                : t('settings.governance.assignedBy', 'Assigned by {{actor}}', { actor: member.assignedBy })}
                            </div>
                          </div>
                          <select
                            value={member.role}
                            disabled={isSaving || isLocalOwner}
                            aria-label={t('settings.governance.roleFor', 'Role for {{actor}}', { actor: member.actorId })}
                            onChange={(event) => {
                              const role = event.target.value
                              if (!isSpaceRole(role)) return
                              const now = new Date().toISOString()
                              void save({
                                ...profile,
                                space: {
                                  ...profile.space,
                                  members: profile.space.members.map((candidate) =>
                                    candidate.actorId === member.actorId
                                      ? { ...candidate, role, assignedBy: profile.space.createdBy, assignedAt: now }
                                      : candidate,
                                  ),
                                },
                              })
                            }}
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          >
                            {SPACE_ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={isSaving || isLocalOwner}
                            aria-label={t('settings.governance.removeMember', 'Remove member')}
                            onClick={() => void save({
                              ...profile,
                              space: {
                                ...profile.space,
                                members: profile.space.members.filter((candidate) => candidate.actorId !== member.actorId),
                              },
                            })}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      )
                    })}
                    <div className="flex items-center gap-2 px-4 py-3 bg-muted/20">
                      <Input
                        value={newActorId}
                        onChange={(event) => setNewActorId(event.target.value)}
                        placeholder={t('settings.governance.actorPlaceholder', 'Member identifier')}
                        className="h-8"
                      />
                      <select
                        value={newActorRole}
                        onChange={(event) => {
                          const role = event.target.value
                          if (isSpaceRole(role)) setNewActorRole(role)
                        }}
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                      >
                        {SPACE_ROLES.filter((role) => role !== 'owner').map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        disabled={isSaving || newActorId.trim() === '' || profile.space.members.some((member) => member.actorId === newActorId.trim())}
                        onClick={() => {
                          const actorId = newActorId.trim()
                          if (!actorId) return
                          const now = new Date().toISOString()
                          setNewActorId('')
                          void save({
                            ...profile,
                            space: {
                              ...profile.space,
                              members: [
                                ...profile.space.members,
                                {
                                  actorId,
                                  role: newActorRole,
                                  assignedBy: profile.space.createdBy,
                                  assignedAt: now,
                                },
                              ],
                            },
                          })
                        }}
                      >
                        <Plus className="size-4 mr-1.5" />
                        {t('settings.governance.add', 'Add')}
                      </Button>
                    </div>
                  </SettingsCard>
                </SettingsSection>

                <SettingsSection
                  title={t('settings.governance.memory', 'Workspace memory')}
                  description={t('settings.governance.memoryDesc', 'Control durable memory and its automatic retention window. Secrets remain references and are never stored in memory.')}
                >
                  <SettingsCard>
                    <SettingsToggle
                      label={t('settings.governance.memoryEnabled', 'Enable durable memory')}
                      description={t('settings.governance.memoryEnabledDesc', 'Allow governed mission context to be retained for this workspace.')}
                      checked={profile.space.memory.enabled}
                      disabled={isSaving}
                      onCheckedChange={(enabled) => void save({
                        ...profile,
                        space: { ...profile.space, memory: { ...profile.space.memory, enabled } },
                      })}
                    />
                    <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-t border-border/60">
                      <div>
                        <div className="text-sm font-medium">{t('settings.governance.retention', 'Retention period')}</div>
                        <div className="text-xs text-muted-foreground">{t('settings.governance.retentionDesc', 'Expired entries are excluded from exports and retrieval.')}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={3650}
                          value={String(profile.space.memory.retentionDays)}
                          disabled={isSaving}
                          onChange={(event) => {
                            const retentionDays = Number.parseInt(event.target.value, 10)
                            if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) return
                            setProfile({
                              ...profile,
                              space: { ...profile.space, memory: { ...profile.space.memory, retentionDays } },
                            })
                          }}
                          onBlur={(event) => {
                            const retentionDays = Number.parseInt(event.target.value, 10)
                            if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) return
                            void save({
                              ...profile,
                              space: { ...profile.space, memory: { ...profile.space.memory, retentionDays } },
                            })
                          }}
                          className="h-8 w-24"
                        />
                        <span className="text-xs text-muted-foreground">{t('settings.governance.days', 'days')}</span>
                      </div>
                    </div>
                  </SettingsCard>
                </SettingsSection>

                <SettingsSection
                  title={t('settings.governance.budgets', 'Mission budgets')}
                  description={t('settings.governance.budgetsDesc', 'Set workspace defaults surfaced in the Control Room before a mission exceeds its envelope.')}
                >
                  <SettingsCard className="p-4 grid gap-4 sm:grid-cols-3">
                    <label className="space-y-1.5">
                      <span className="text-xs font-medium">{t('settings.governance.maxTokens', 'Max tokens')}</span>
                      <Input
                        type="number"
                        min={1}
                        value={profile.budgets.missionMaxTokens ?? ''}
                        disabled={isSaving}
                        onChange={(event) => setProfile({
                          ...profile,
                          budgets: { ...profile.budgets, missionMaxTokens: optionalPositiveNumber(event.target.value) },
                        })}
                        onBlur={(event) => void save({
                          ...profile,
                          budgets: {
                            ...profile.budgets,
                            missionMaxTokens: optionalPositiveNumber(event.target.value),
                          },
                        })}
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className="text-xs font-medium">{t('settings.governance.maxCost', 'Max cost (USD)')}</span>
                      <Input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={profile.budgets.missionMaxCostUsd ?? ''}
                        disabled={isSaving}
                        onChange={(event) => setProfile({
                          ...profile,
                          budgets: { ...profile.budgets, missionMaxCostUsd: optionalPositiveNumber(event.target.value) },
                        })}
                        onBlur={(event) => void save({
                          ...profile,
                          budgets: {
                            ...profile.budgets,
                            missionMaxCostUsd: optionalPositiveNumber(event.target.value),
                          },
                        })}
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className="text-xs font-medium">{t('settings.governance.warningAt', 'Warn at (%)')}</span>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={profile.budgets.warningPercent}
                        disabled={isSaving}
                        onChange={(event) => {
                          const warningPercent = Number.parseInt(event.target.value, 10)
                          if (warningPercent < 1 || warningPercent > 100) return
                          setProfile({ ...profile, budgets: { ...profile.budgets, warningPercent } })
                        }}
                        onBlur={(event) => {
                          const warningPercent = Number.parseInt(event.target.value, 10)
                          if (warningPercent < 1 || warningPercent > 100) return
                          void save({
                            ...profile,
                            budgets: { ...profile.budgets, warningPercent },
                          })
                        }}
                      />
                    </label>
                  </SettingsCard>
                </SettingsSection>

                <SettingsSection
                  title={t('settings.governance.remote', 'Remote supervision')}
                  description={t('settings.governance.remoteDesc', 'Local-only by default. Share selected operational metadata only after explicit, expiring consent.')}
                >
                  <div data-testid="remote-supervision-section">
                    <SettingsCard>
                    <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border/60">
                      <div className={`size-2.5 rounded-full ${activeRemoteConsent ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">
                          {activeRemoteConsent
                            ? t('settings.governance.remoteMetadata', 'Remote metadata supervision active')
                            : t('settings.governance.remoteLocalOnly', 'Local only')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {activeRemoteConsent
                            ? t('settings.governance.remoteExpires', 'Consent expires {{date}}', {
                                date: new Date(activeRemoteConsent.expiresAt).toLocaleString(),
                              })
                            : t('settings.governance.remoteLocalOnlyDesc', 'No workspace data is synchronized to a remote supervisor.')}
                        </div>
                      </div>
                    </div>

                    <SettingsToggle
                      label={t('settings.governance.remoteEnabled', 'Enable remote metadata supervision')}
                      description={t('settings.governance.remoteEnabledDesc', 'Task content, prompts, files, credentials, and secret values are never included.')}
                      checked={activeRemoteConsent !== null}
                      disabled={isRemoteSaving}
                      onCheckedChange={(enabled) => void handleRemoteSupervisionChange(enabled)}
                    />

                    <div className="grid gap-5 border-t border-border/60 px-4 py-4 sm:grid-cols-2">
                      <fieldset className="space-y-2" disabled={isRemoteSaving || activeRemoteConsent !== null}>
                        <legend className="text-xs font-medium">
                          {t('settings.governance.remoteFields', 'Shared metadata fields')}
                        </legend>
                        {REMOTE_SYNC_FIELDS.map((field) => (
                          <label key={field} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={remoteFields.includes(field)}
                              onChange={() => toggleRemoteField(field)}
                              className="size-3.5 rounded border-border"
                            />
                            <span>{t(`settings.governance.remoteField.${field}`, field)}</span>
                          </label>
                        ))}
                      </fieldset>

                      <fieldset className="space-y-2" disabled={isRemoteSaving || activeRemoteConsent !== null}>
                        <legend className="text-xs font-medium">
                          {t('settings.governance.remoteActions', 'Allowed remote actions')}
                        </legend>
                        {REMOTE_ACTIONS.map((action) => (
                          <label key={action} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={remoteActions.includes(action)}
                              onChange={() => toggleRemoteAction(action)}
                              className="size-3.5 rounded border-border"
                            />
                            <span>{t(`settings.governance.remoteAction.${action}`, action)}</span>
                          </label>
                        ))}
                      </fieldset>
                    </div>

                    <div className="grid gap-4 border-t border-border/60 px-4 py-4 sm:grid-cols-[1fr_9rem]">
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium">
                          {t('settings.governance.remotePurpose', 'Access purpose')}
                        </span>
                        <Input
                          value={remotePurpose}
                          disabled={isRemoteSaving || activeRemoteConsent !== null}
                          onChange={(event) => setRemotePurpose(event.target.value)}
                          placeholder={t('settings.governance.remotePurposePlaceholder', 'Operational support')}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium">
                          {t('settings.governance.remoteExpiry', 'Expiry (hours)')}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={720}
                          value={remoteExpiryHours}
                          disabled={isRemoteSaving || activeRemoteConsent !== null}
                          onChange={(event) => setRemoteExpiryHours(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
                      {t('settings.governance.remoteAuditNotice', 'Grant, revocation, and every authorized or denied remote action extend a local tamper-evident audit chain.')}
                    </div>
                    </SettingsCard>
                  </div>
                </SettingsSection>

                <SettingsSection
                  title={t('settings.governance.audit', 'Governance audit')}
                  description={t('settings.governance.auditDesc', 'Every role, memory, and budget change extends a tamper-evident SHA-256 chain.')}
                >
                  <SettingsCard>
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
                      {auditVerification.valid ? (
                        <CheckCircle2 className="size-4 text-emerald-500" />
                      ) : (
                        <ShieldAlert className="size-4 text-destructive" />
                      )}
                      <span className="text-sm font-medium">
                        {auditVerification.valid
                          ? t('settings.governance.auditValid', 'Audit chain verified')
                          : t('settings.governance.auditInvalid', 'Audit chain invalid')}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t('settings.governance.events', '{{count}} events', { count: profile.audit.length })}
                      </span>
                    </div>
                    {profile.audit.length === 0 ? (
                      <div className="px-4 py-5 text-sm text-muted-foreground">
                        {t('settings.governance.noEvents', 'No governance changes recorded yet.')}
                      </div>
                    ) : (
                      profile.audit.slice(-10).reverse().map((event) => (
                        <div key={event.hash} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3 border-b border-border/60 last:border-b-0">
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{event.targetId}</div>
                            <div className="text-xs text-muted-foreground">
                              {event.action} · {event.actorId} · {new Date(event.timestamp).toLocaleString()}
                            </div>
                          </div>
                          <code className="text-[10px] text-muted-foreground self-center">{event.hash.slice(0, 12)}</code>
                        </div>
                      ))
                    )}
                  </SettingsCard>
                </SettingsSection>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
