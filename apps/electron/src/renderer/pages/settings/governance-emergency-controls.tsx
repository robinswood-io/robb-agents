import * as React from 'react';

import { ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings';

import type { TaskKillSwitchSnapshotDto } from '@craft-agent/shared/protocol';

interface GovernanceEmergencyControlsProps {
  t: import("i18next").TFunction<"translation", undefined>
  killSwitches: TaskKillSwitchSnapshotDto | null
  killSwitchReason: string
  isKillSwitchSaving: boolean
  setKillSwitchReason: React.Dispatch<React.SetStateAction<string>>
  updateKillSwitch: (scope: "global" | "workspace" | "mission" | "connector", id: string | undefined, active: boolean) => Promise<void>
  workspaceId: string
  missionKillSwitchId: string
  setMissionKillSwitchId: React.Dispatch<React.SetStateAction<string>>
  connectorKillSwitchId: string
  setConnectorKillSwitchId: React.Dispatch<React.SetStateAction<string>>
}

export function GovernanceEmergencyControls({
  t,
  killSwitches,
  killSwitchReason,
  isKillSwitchSaving,
  setKillSwitchReason,
  updateKillSwitch,
  workspaceId,
  missionKillSwitchId,
  setMissionKillSwitchId,
  connectorKillSwitchId,
  setConnectorKillSwitchId,
}: GovernanceEmergencyControlsProps) {
  return (
<SettingsSection
                  title={t('settings.governance.killSwitchTitle', 'Emergency controls')}
                  description={t('settings.governance.killSwitchDesc', 'Durable kill switches stop new work and immediately drain affected active missions. Every change is attributed and appended to a tamper-evident audit chain.')}
                >
                  <div data-testid="kill-switch-section">
                    <SettingsCard>
                      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3.5">
                        <ShieldAlert className="size-4 text-destructive" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {killSwitches && (
                              killSwitches.global
                              || killSwitches.workspaceIds.length > 0
                              || killSwitches.missionIds.length > 0
                              || killSwitches.connectorIds.length > 0
                            )
                              ? t('settings.governance.killSwitchActive', 'One or more emergency stops are active')
                              : t('settings.governance.killSwitchInactive', 'No emergency stop is active')}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t('settings.governance.killSwitchGeneration', 'Registry generation {{generation}}', {
                              generation: killSwitches?.generation ?? 0,
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="border-b border-border/60 px-4 py-3.5">
                        <label className="space-y-1.5">
                          <span className="text-xs font-medium">
                            {t('settings.governance.killSwitchReason', 'Reason for change')}
                          </span>
                          <Input
                            value={killSwitchReason}
                            maxLength={1_000}
                            disabled={isKillSwitchSaving}
                            onChange={(event) => setKillSwitchReason(event.target.value)}
                            placeholder={t('settings.governance.killSwitchReasonPlaceholder', 'Incident, containment decision, or recovery reference')}
                          />
                        </label>
                      </div>

                      <SettingsToggle
                        label={t('settings.governance.killSwitchGlobal', 'Stop all missions')}
                        description={t('settings.governance.killSwitchGlobalDesc', 'Global scope. Requires an authoritative owner and applies across every workspace.')}
                        checked={killSwitches?.global ?? false}
                        disabled={isKillSwitchSaving || !killSwitches}
                        onCheckedChange={(active) => void updateKillSwitch('global', undefined, active)}
                      />
                      <SettingsToggle
                        label={t('settings.governance.killSwitchWorkspace', 'Stop this workspace')}
                        description={t('settings.governance.killSwitchWorkspaceDesc', 'Stops every active and future mission in the selected workspace.')}
                        checked={workspaceId ? (killSwitches?.workspaceIds.includes(workspaceId) ?? false) : false}
                        disabled={isKillSwitchSaving || !killSwitches || !workspaceId}
                        onCheckedChange={(active) => {
                          if (workspaceId) void updateKillSwitch('workspace', workspaceId, active)
                        }}
                      />

                      <div className="grid gap-4 border-t border-border/60 px-4 py-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="space-y-1.5">
                            <span className="text-xs font-medium">
                              {t('settings.governance.killSwitchMissionId', 'Mission identifier')}
                            </span>
                            <div className="flex gap-2">
                              <Input
                                value={missionKillSwitchId}
                                disabled={isKillSwitchSaving}
                                onChange={(event) => setMissionKillSwitchId(event.target.value)}
                              />
                              <Button
                                type="button"
                                size="sm"
                                disabled={isKillSwitchSaving || missionKillSwitchId.trim() === ''}
                                onClick={() => void updateKillSwitch('mission', missionKillSwitchId.trim(), true)}
                              >
                                {t('settings.governance.killSwitchActivate', 'Activate')}
                              </Button>
                            </div>
                          </label>
                          {killSwitches?.missionIds.map((missionId) => (
                            <div key={missionId} className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/[0.04] px-2.5 py-2">
                              <span className="min-w-0 flex-1 truncate text-xs font-medium">{missionId}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={isKillSwitchSaving}
                                onClick={() => void updateKillSwitch('mission', missionId, false)}
                              >
                                {t('settings.governance.killSwitchDeactivate', 'Deactivate')}
                              </Button>
                            </div>
                          ))}
                        </div>

                        <div className="space-y-2">
                          <label className="space-y-1.5">
                            <span className="text-xs font-medium">
                              {t('settings.governance.killSwitchConnectorId', 'Connector identifier')}
                            </span>
                            <div className="flex gap-2">
                              <Input
                                value={connectorKillSwitchId}
                                disabled={isKillSwitchSaving}
                                onChange={(event) => setConnectorKillSwitchId(event.target.value)}
                              />
                              <Button
                                type="button"
                                size="sm"
                                disabled={isKillSwitchSaving || connectorKillSwitchId.trim() === ''}
                                onClick={() => void updateKillSwitch('connector', connectorKillSwitchId.trim(), true)}
                              >
                                {t('settings.governance.killSwitchActivate', 'Activate')}
                              </Button>
                            </div>
                          </label>
                          {killSwitches?.connectorIds.map((connectorId) => (
                            <div key={connectorId} className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/[0.04] px-2.5 py-2">
                              <span className="min-w-0 flex-1 truncate text-xs font-medium">{connectorId}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={isKillSwitchSaving}
                                onClick={() => void updateKillSwitch('connector', connectorId, false)}
                              >
                                {t('settings.governance.killSwitchDeactivate', 'Deactivate')}
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </SettingsCard>
                  </div>
                </SettingsSection>
  )
}
