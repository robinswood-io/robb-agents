import { useCallback, useEffect, useState } from 'react';
import "react";
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import "@/components/ui/HeaderMenu";
import "@/components/ui/scroll-area";
import "@/components/ui/button";
import "@/components/ui/input";
import "@/components/settings";
import { useAppShellContext } from '@/context/AppShellContext';
import "@/lib/navigate";
import { verifyGovernanceAuditInBrowser, type GovernanceAuditVerification } from '@/lib/governance-audit';

import { GovernanceSettingsContent } from "./governance-settings-content";
import { DEFAULT_REMOTE_FIELDS, DEFAULT_REMOTE_ACTIONS } from "./governance-settings-options";









import type { DetailsPageMeta } from '@/lib/navigation-registry';

import type { SpaceRole, WorkspaceGovernanceProfile } from '@craft-agent/shared/governance';
import type { TaskKillSwitchSnapshotDto } from '@craft-agent/shared/protocol';
import type { RemoteAction, RemoteSupervisionProfile, RemoteSyncField } from '@craft-agent/shared/remote-supervision';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'governance',
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
  const [killSwitches, setKillSwitches] = useState<TaskKillSwitchSnapshotDto | null>(null)
  const [killSwitchReason, setKillSwitchReason] = useState('')
  const [missionKillSwitchId, setMissionKillSwitchId] = useState('')
  const [connectorKillSwitchId, setConnectorKillSwitchId] = useState('')
  const [isKillSwitchSaving, setIsKillSwitchSaving] = useState(false)
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
      setKillSwitches(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const [settings, taskKillSwitches] = await Promise.all([
        window.electronAPI.getWorkspaceSettings(workspaceId),
        window.electronAPI.getTaskKillSwitches(workspaceId),
      ])
      setProfile(settings?.governance ?? null)
      setGovernanceRevision(settings?.governanceRevision ?? 0)
      setGovernanceUpdatedAt(settings?.governanceUpdatedAt ?? null)
      setGovernanceUpdatedBy(settings?.governanceUpdatedBy ?? null)
      setKillSwitches(taskKillSwitches)
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

  const updateKillSwitch = useCallback(async (
    scope: 'global' | 'workspace' | 'mission' | 'connector',
    id: string | undefined,
    active: boolean,
  ) => {
    if (!workspaceId || !window.electronAPI || !killSwitches) return
    const reason = killSwitchReason.trim()
    if (!reason) {
      toast.error(t('settings.governance.killSwitchReasonRequired', 'A reason is required for every emergency-control change.'))
      return
    }
    setIsKillSwitchSaving(true)
    try {
      const next = await window.electronAPI.setTaskKillSwitch(workspaceId, {
        scope,
        active,
        ...(id ? { id } : {}),
        reason,
        expectedGeneration: killSwitches.generation,
      })
      setKillSwitches(next)
      setKillSwitchReason('')
      if (scope === 'mission' && active) setMissionKillSwitchId('')
      if (scope === 'connector' && active) setConnectorKillSwitchId('')
      toast.success(t('settings.governance.killSwitchSaved', 'Emergency controls updated'))
    } catch (error) {
      console.error('Failed to update kill switch:', error)
      try {
        setKillSwitches(await window.electronAPI.getTaskKillSwitches(workspaceId))
      } catch (refreshError) {
        console.error('Failed to refresh kill switches after update error:', refreshError)
      }
      toast.error(error instanceof Error
        ? error.message
        : t('settings.governance.killSwitchSaveFailed', 'Unable to update emergency controls'))
    } finally {
      setIsKillSwitchSaving(false)
    }
  }, [killSwitchReason, killSwitches, t, workspaceId])

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
    <GovernanceSettingsContent
      t={t}
      selectableWorkspaces={selectableWorkspaces}
      workspaceId={workspaceId}
      isSaving={isSaving}
      setSelectedWorkspaceId={setSelectedWorkspaceId}
      profile={profile}
      governanceRevision={governanceRevision}
      governanceUpdatedAt={governanceUpdatedAt}
      governanceUpdatedBy={governanceUpdatedBy}
      save={save}
      newActorId={newActorId}
      setNewActorId={setNewActorId}
      newActorRole={newActorRole}
      setNewActorRole={setNewActorRole}
      setProfile={setProfile}
      killSwitches={killSwitches}
      killSwitchReason={killSwitchReason}
      isKillSwitchSaving={isKillSwitchSaving}
      setKillSwitchReason={setKillSwitchReason}
      updateKillSwitch={updateKillSwitch}
      missionKillSwitchId={missionKillSwitchId}
      setMissionKillSwitchId={setMissionKillSwitchId}
      connectorKillSwitchId={connectorKillSwitchId}
      setConnectorKillSwitchId={setConnectorKillSwitchId}
      activeRemoteConsent={activeRemoteConsent}
      isRemoteSaving={isRemoteSaving}
      handleRemoteSupervisionChange={handleRemoteSupervisionChange}
      remoteFields={remoteFields}
      toggleRemoteField={toggleRemoteField}
      remoteActions={remoteActions}
      toggleRemoteAction={toggleRemoteAction}
      remotePurpose={remotePurpose}
      setRemotePurpose={setRemotePurpose}
      remoteExpiryHours={remoteExpiryHours}
      setRemoteExpiryHours={setRemoteExpiryHours}
      auditVerification={auditVerification}
    />
  )
}
