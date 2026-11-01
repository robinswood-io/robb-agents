import * as React from 'react';

import { Input } from '@/components/ui/input';
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings';

import type { RemoteAction, RemoteSyncField } from '@craft-agent/shared/remote-supervision';
import { REMOTE_SYNC_FIELDS, REMOTE_ACTIONS } from "./governance-settings-options";

interface GovernanceRemoteSupervisionProps {
  t: import("i18next").TFunction<"translation", undefined>
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
}

export function GovernanceRemoteSupervision({
  t,
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
}: GovernanceRemoteSupervisionProps) {
  return (
<SettingsSection
                  title={t('settings.governance.remote', 'Remote supervision')}
                  description={t('settings.governance.remoteDesc', 'Local-only by default. Share selected operational metadata only after explicit, expiring consent.')}
                >
                  <div data-testid="remote-supervision-section">
                    <SettingsCard>
                    <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border/60">
                      <div className={`size-2.5 rounded-full ${activeRemoteConsent ? 'bg-success' : 'bg-muted-foreground/50'}`} />
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
  )
}
