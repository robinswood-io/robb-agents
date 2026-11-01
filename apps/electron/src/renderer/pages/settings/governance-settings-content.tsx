import * as React from 'react';

import { CheckCircle2, Plus, ShieldAlert, Trash2 } from 'lucide-react';

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings';

import { routes } from '@/lib/navigate';

import { type GovernanceAuditVerification } from '@/lib/governance-audit';
import type { WorkspaceGovernanceProfile } from '@craft-agent/shared/governance';
import type { TaskKillSwitchSnapshotDto } from '@craft-agent/shared/protocol';
import type { RemoteAction, RemoteSyncField } from '@craft-agent/shared/remote-supervision';
import { GovernanceEmergencyControls } from "./governance-emergency-controls";
import { GovernanceRemoteSupervision } from "./governance-remote-supervision";
import { SPACE_ROLES, optionalPositiveNumber, isSpaceRole } from "./governance-settings-options";

interface GovernanceSettingsContentProps {
  t: import("i18next").TFunction<"translation", undefined>
  selectableWorkspaces: import("@craft-agent/core").Workspace[]
  workspaceId: string | null
  isSaving: boolean
  setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>
  profile: { schemaVersion: 1; space: { schemaVersion: 1; id: string; kind: "personal" | "team" | "client"; name: string; members: { actorId: string; role: "owner" | "admin" | "operator" | "validator" | "reader"; assignedBy: string; assignedAt: string; }[]; memory: { enabled: boolean; retentionDays: number; }; createdBy: string; createdAt: string; }; budgets: { warningPercent: number; missionMaxTokens?: number | undefined; missionMaxCostUsd?: number | undefined; }; audit: { sequence: number; spaceId: string; action: "member.role.changed" | "policy.versioned" | "playbook.versioned" | "connection.versioned" | "memory.exported" | "memory.purged"; actorId: string; targetId: string; timestamp: string; detailsHash: string; previousHash: string; hash: string; }[]; } | null
  governanceRevision: number
  governanceUpdatedAt: string | null
  governanceUpdatedBy: string | null
  save: (next: WorkspaceGovernanceProfile) => Promise<void>
  newActorId: string
  setNewActorId: React.Dispatch<React.SetStateAction<string>>
  newActorRole: "owner" | "admin" | "operator" | "validator" | "reader"
  setNewActorRole: React.Dispatch<React.SetStateAction<"owner" | "admin" | "operator" | "validator" | "reader">>
  setProfile: React.Dispatch<React.SetStateAction<{ schemaVersion: 1; space: { schemaVersion: 1; id: string; kind: "personal" | "team" | "client"; name: string; members: { actorId: string; role: "owner" | "admin" | "operator" | "validator" | "reader"; assignedBy: string; assignedAt: string; }[]; memory: { enabled: boolean; retentionDays: number; }; createdBy: string; createdAt: string; }; budgets: { warningPercent: number; missionMaxTokens?: number | undefined; missionMaxCostUsd?: number | undefined; }; audit: { sequence: number; spaceId: string; action: "member.role.changed" | "policy.versioned" | "playbook.versioned" | "connection.versioned" | "memory.exported" | "memory.purged"; actorId: string; targetId: string; timestamp: string; detailsHash: string; previousHash: string; hash: string; }[]; } | null>>
  killSwitches: TaskKillSwitchSnapshotDto | null
  killSwitchReason: string
  isKillSwitchSaving: boolean
  setKillSwitchReason: React.Dispatch<React.SetStateAction<string>>
  updateKillSwitch: (scope: "global" | "workspace" | "mission" | "connector", id: string | undefined, active: boolean) => Promise<void>
  missionKillSwitchId: string
  setMissionKillSwitchId: React.Dispatch<React.SetStateAction<string>>
  connectorKillSwitchId: string
  setConnectorKillSwitchId: React.Dispatch<React.SetStateAction<string>>
  activeRemoteConsent: import("@craft-agent/shared/remote-supervision").RemoteSupervisionConsent | null
  isRemoteSaving: boolean
  handleRemoteSupervisionChange: (enabled: boolean) => Promise<void>
  remoteFields: RemoteSyncField[]
  toggleRemoteField: (field: RemoteSyncField) => void
  remoteActions: RemoteAction[]
  toggleRemoteAction: (action: RemoteAction) => void
  remotePurpose: string
  setRemotePurpose: React.Dispatch<React.SetStateAction<string>>
  remoteExpiryHours: string
  setRemoteExpiryHours: React.Dispatch<React.SetStateAction<string>>
  auditVerification: GovernanceAuditVerification
}

export function GovernanceSettingsContent({
  t,
  selectableWorkspaces,
  workspaceId,
  isSaving,
  setSelectedWorkspaceId,
  profile,
  governanceRevision,
  governanceUpdatedAt,
  governanceUpdatedBy,
  save,
  newActorId,
  setNewActorId,
  newActorRole,
  setNewActorRole,
  setProfile,
  killSwitches,
  killSwitchReason,
  isKillSwitchSaving,
  setKillSwitchReason,
  updateKillSwitch,
  missionKillSwitchId,
  setMissionKillSwitchId,
  connectorKillSwitchId,
  setConnectorKillSwitchId,
  activeRemoteConsent,
  isRemoteSaving,
  handleRemoteSupervisionChange,
  remoteFields,
  toggleRemoteField,
  remoteActions,
  toggleRemoteAction,
  remotePurpose,
  setRemotePurpose,
  remoteExpiryHours,
  setRemoteExpiryHours,
  auditVerification,
}: GovernanceSettingsContentProps) {

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

                <GovernanceEmergencyControls
  t={t}
  killSwitches={killSwitches}
  killSwitchReason={killSwitchReason}
  isKillSwitchSaving={isKillSwitchSaving}
  setKillSwitchReason={setKillSwitchReason}
  updateKillSwitch={updateKillSwitch}
  workspaceId={workspaceId}
  missionKillSwitchId={missionKillSwitchId}
  setMissionKillSwitchId={setMissionKillSwitchId}
  connectorKillSwitchId={connectorKillSwitchId}
  setConnectorKillSwitchId={setConnectorKillSwitchId}
/>

                <GovernanceRemoteSupervision
  t={t}
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
/>

                <SettingsSection
                  title={t('settings.governance.audit', 'Governance audit')}
                  description={t('settings.governance.auditDesc', 'Every role, memory, and budget change extends a tamper-evident SHA-256 chain.')}
                >
                  <SettingsCard>
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
                      {auditVerification.valid ? (
                        <CheckCircle2 className="size-4 text-success" />
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
