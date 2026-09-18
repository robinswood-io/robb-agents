import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type {
  SpecializedAgentProfileDefinition,
  SpecializationOpportunityProposal,
  SpecializedProfileAnalysisResult,
  SpecializedProfileRecord,
  SpecializedProfileRegistryDocument,
  SpecializedProfileState,
  SpecializedProfileEvaluation,
} from '@craft-agent/shared/specialized-profiles'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'profiles',
}

/**
 * Renderer-safe subset of the host transition graph. The host remains
 * authoritative and validates every request; approval-bearing promotion
 * states are deliberately absent from this UI.
 */
function safeTransitionsFrom(state: SpecializedProfileState): readonly SpecializedProfileState[] {
  switch (state) {
    case 'candidate': return ['draft', 'revoked']
    case 'draft': return ['shadow', 'retired', 'revoked']
    case 'shadow': return ['draft', 'retired', 'revoked']
    case 'opt-in': return ['shadow', 'retired', 'revoked']
    case 'canary':
    case 'default': return ['retired', 'revoked']
    case 'retired': return ['draft', 'revoked']
    case 'revoked': return []
  }
}

const STATE_LABEL_KEYS: Record<SpecializedProfileState, string> = {
  candidate: 'settings.profiles.state.candidate',
  draft: 'settings.profiles.state.draft',
  shadow: 'settings.profiles.state.shadow',
  'opt-in': 'settings.profiles.state.optIn',
  canary: 'settings.profiles.state.canary',
  default: 'settings.profiles.state.default',
  retired: 'settings.profiles.state.retired',
  revoked: 'settings.profiles.state.revoked',
}

const CATEGORY_LABEL_KEYS: Record<SpecializationOpportunityProposal['category'], string> = {
  'platform-fix': 'settings.profiles.category.platformFix',
  memory: 'settings.profiles.category.memory',
  automation: 'settings.profiles.category.automation',
  'agent-profile': 'settings.profiles.category.agentProfile',
  skill: 'settings.profiles.category.skill',
}

function latestOfflineEvaluation(profile: SpecializedProfileRecord): SpecializedProfileEvaluation | undefined {
  return profile.evaluations
    .filter((evaluation) =>
      evaluation.profileVersion === profile.currentVersion && evaluation.stage === 'offline')
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
    .at(-1)
}

function evaluationPassesShadowGate(
  evaluation: SpecializedProfileEvaluation | undefined,
  definition: SpecializedAgentProfileDefinition,
): boolean {
  if (!evaluation || evaluation.outcome !== 'pass') return false
  if (evaluation.metrics.caseCount < 20) return false
  if (evaluation.metrics.verifiedPassRate < 0.95) return false
  if (
    evaluation.metrics.verifiedPassCount / evaluation.metrics.caseCount
    !== evaluation.metrics.verifiedPassRate
  ) return false
  if (evaluation.metrics.falseCompletionCount !== 0) return false
  if (evaluation.metrics.policyViolationCount !== 0) return false
  if (evaluation.metrics.completeReceiptCount !== evaluation.metrics.requiredReceiptCount) return false
  if (
    definition.requestedCapabilities.some((capability) => capability.kind === 'external-mutation')
    && (evaluation.metrics.mutationCaseCount === 0 || evaluation.metrics.requiredReceiptCount === 0)
  ) return false
  return Date.parse(evaluation.validUntil) > Date.now()
}

function currentVersion(profile: SpecializedProfileRecord) {
  return profile.versions[profile.currentVersion - 1]
}

function proposalAlreadyDrafted(
  registry: SpecializedProfileRegistryDocument | null,
  proposal: SpecializationOpportunityProposal,
): boolean {
  return registry?.profiles.some((profile) =>
    profile.versions.some((version) =>
      version.definition.specialty === proposal.normalizedFamily)) ?? false
}

export default function ProfilesSettingsPage() {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId, workspaces, onSelectWorkspace } = useAppShellContext()
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const [registry, setRegistry] = useState<SpecializedProfileRegistryDocument | null>(null)
  const [analysis, setAnalysis] = useState<SpecializedProfileAnalysisResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [transitionReasons, setTransitionReasons] = useState<Record<string, string>>({})
  const registryRequestGeneration = useRef(0)
  const analysisRequestGeneration = useRef(0)

  const workspaceId = activeWorkspaceId
  const workspaceGeneration = useRef(0)
  const currentWorkspaceId = useRef(workspaceId)

  const isCurrentWorkspace = useCallback((expectedWorkspaceId: string | null, generation: number) =>
    currentWorkspaceId.current === expectedWorkspaceId
    && workspaceGeneration.current === generation, [])

  const commitRegistry = useCallback((
    expectedWorkspaceId: string,
    generation: number,
    nextRegistry: SpecializedProfileRegistryDocument,
  ): boolean => {
    if (!isCurrentWorkspace(expectedWorkspaceId, generation)) return false
    if (nextRegistry.workspaceId !== expectedWorkspaceId) return false
    setIsLoading(false)
    setRegistry((current) => {
      if (
        current?.workspaceId === expectedWorkspaceId
        && current.revision > nextRegistry.revision
      ) return current
      return nextRegistry
    })
    return true
  }, [isCurrentWorkspace])

  const loadRegistry = useCallback(async () => {
    const requestedWorkspaceId = workspaceId
    const requestedWorkspaceGeneration = workspaceGeneration.current
    const requestGeneration = ++registryRequestGeneration.current
    if (!requestedWorkspaceId || !window.electronAPI) {
      if (isCurrentWorkspace(requestedWorkspaceId, requestedWorkspaceGeneration)) {
        setRegistry(null)
        setIsLoading(false)
      }
      return
    }
    setIsLoading(true)
    try {
      const nextRegistry = await window.electronAPI.getSpecializedProfileRegistry(requestedWorkspaceId)
      if (registryRequestGeneration.current === requestGeneration) {
        commitRegistry(requestedWorkspaceId, requestedWorkspaceGeneration, nextRegistry)
      }
    } catch (error) {
      if (
        registryRequestGeneration.current !== requestGeneration
        || !isCurrentWorkspace(requestedWorkspaceId, requestedWorkspaceGeneration)
      ) return
      console.error('Failed to load specialized profiles:', error)
      toast.error(t('settings.profiles.loadFailed'))
    } finally {
      if (
        registryRequestGeneration.current === requestGeneration
        && isCurrentWorkspace(requestedWorkspaceId, requestedWorkspaceGeneration)
      ) setIsLoading(false)
    }
  }, [commitRegistry, isCurrentWorkspace, t, workspaceId])

  const handleWorkspaceChange = useCallback(async (nextWorkspaceId: string) => {
    if (!nextWorkspaceId || nextWorkspaceId === activeWorkspaceId || pendingWorkspaceId !== null) return
    const previousWorkspaceId = activeWorkspaceId
    workspaceGeneration.current += 1
    registryRequestGeneration.current += 1
    analysisRequestGeneration.current += 1
    currentWorkspaceId.current = null
    setAnalysis(null)
    setIsAnalyzing(false)
    setRegistry(null)
    setPendingAction(null)
    setTransitionReasons({})
    setPendingWorkspaceId(nextWorkspaceId)
    try {
      await onSelectWorkspace(nextWorkspaceId)
    } catch (error) {
      currentWorkspaceId.current = previousWorkspaceId
      workspaceGeneration.current += 1
      setPendingWorkspaceId(null)
      console.error('Failed to switch specialized-profile workspace:', error)
      toast.error(t('settings.profiles.workspaceSwitchFailed'))
      await loadRegistry()
    }
  }, [activeWorkspaceId, loadRegistry, onSelectWorkspace, pendingWorkspaceId, t])

  useEffect(() => {
    if (pendingWorkspaceId && activeWorkspaceId === pendingWorkspaceId) {
      setPendingWorkspaceId(null)
    }
  }, [activeWorkspaceId, pendingWorkspaceId])

  useEffect(() => {
    if (currentWorkspaceId.current !== workspaceId) {
      currentWorkspaceId.current = workspaceId
      workspaceGeneration.current += 1
      registryRequestGeneration.current += 1
      analysisRequestGeneration.current += 1
      setAnalysis(null)
      setIsAnalyzing(false)
      setRegistry(null)
      setPendingAction(null)
      setTransitionReasons({})
    }
    void loadRegistry()
  }, [loadRegistry, workspaceId])

  useEffect(() => {
    if (!window.electronAPI || !workspaceId) return
    const subscriptionWorkspaceGeneration = workspaceGeneration.current
    return window.electronAPI.onSpecializedProfilesChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        if (!isCurrentWorkspace(workspaceId, subscriptionWorkspaceGeneration)) return
        void loadRegistry()
      }
    })
  }, [isCurrentWorkspace, loadRegistry, workspaceId])

  const sortedProfiles = useMemo(
    () => [...(registry?.profiles ?? [])]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [registry],
  )

  const handleAnalyze = useCallback(async () => {
    if (pendingWorkspaceId !== null || !workspaceId || !window.electronAPI) return
    const requestedWorkspaceGeneration = workspaceGeneration.current
    if (!isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)) return
    const requestGeneration = ++analysisRequestGeneration.current
    setIsAnalyzing(true)
    try {
      const nextAnalysis = await window.electronAPI.analyzeSpecializedProfiles(workspaceId)
      if (
        analysisRequestGeneration.current === requestGeneration
        && isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)
      ) setAnalysis(nextAnalysis)
    } catch (error) {
      if (
        analysisRequestGeneration.current !== requestGeneration
        || !isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)
      ) return
      console.error('Failed to analyze specialization opportunities:', error)
      toast.error(t('settings.profiles.analysisFailed'))
    } finally {
      if (
        analysisRequestGeneration.current === requestGeneration
        && isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)
      ) setIsAnalyzing(false)
    }
  }, [isCurrentWorkspace, pendingWorkspaceId, t, workspaceId])

  const handleCreateDraft = useCallback(async (proposal: SpecializationOpportunityProposal) => {
    if (
      !workspaceId
      || pendingWorkspaceId !== null
      || !registry
      || registry.workspaceId !== workspaceId
      || proposal.category !== 'agent-profile'
      || !window.electronAPI
    ) return
    const requestedWorkspaceGeneration = workspaceGeneration.current
    if (!isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)) return
    if (!window.confirm(t('settings.profiles.createConfirm', { family: proposal.family }))) return

    const actionId = `${requestedWorkspaceGeneration}:proposal:${proposal.proposalId}`
    setPendingAction(actionId)
    try {
      const result = await window.electronAPI.createSpecializedProfileDraft(workspaceId, {
        proposalId: proposal.proposalId,
        expectedRegistryRevision: registry.revision,
      })
      if (!commitRegistry(workspaceId, requestedWorkspaceGeneration, result.registry)) return
      toast.success(t('settings.profiles.draftCreated'))
    } catch (error) {
      if (!isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)) return
      console.error('Failed to create specialized profile draft:', error)
      toast.error(error instanceof Error ? error.message : t('settings.profiles.createFailed'))
      await loadRegistry()
    } finally {
      setPendingAction((current) => current === actionId ? null : current)
    }
  }, [commitRegistry, isCurrentWorkspace, loadRegistry, pendingWorkspaceId, registry, t, workspaceId])

  const handleTransition = useCallback(async (
    profile: SpecializedProfileRecord,
    to: SpecializedProfileState,
  ) => {
    if (
      pendingWorkspaceId !== null
      || !workspaceId
      || !registry
      || registry.workspaceId !== workspaceId
      || !window.electronAPI
    ) return
    const requestedWorkspaceGeneration = workspaceGeneration.current
    if (!isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)) return
    const reason = transitionReasons[profile.id]?.trim() ?? ''
    if (!reason) {
      toast.error(t('settings.profiles.reasonRequired'))
      return
    }
    const targetLabel = t(STATE_LABEL_KEYS[to])
    const displayName = currentVersion(profile)?.definition.displayName ?? profile.id
    if (!window.confirm(t('settings.profiles.transitionConfirm', {
      name: displayName,
      state: targetLabel,
    }))) return

    const offlineEvaluation = to === 'shadow' ? latestOfflineEvaluation(profile) : undefined
    const actionId = `${requestedWorkspaceGeneration}:profile:${profile.id}:${to}`
    setPendingAction(actionId)
    try {
      const result = await window.electronAPI.transitionSpecializedProfile(workspaceId, {
        profileId: profile.id,
        expectedRegistryRevision: registry.revision,
        expectedCurrentVersion: profile.currentVersion,
        to,
        reason,
        ...(offlineEvaluation ? { evaluationIds: [offlineEvaluation.id] } : {}),
      })
      if (!commitRegistry(workspaceId, requestedWorkspaceGeneration, result.registry)) return
      setTransitionReasons((current) => ({ ...current, [profile.id]: '' }))
      toast.success(t('settings.profiles.transitioned', { state: targetLabel }))
    } catch (error) {
      if (!isCurrentWorkspace(workspaceId, requestedWorkspaceGeneration)) return
      console.error('Failed to transition specialized profile:', error)
      toast.error(error instanceof Error ? error.message : t('settings.profiles.transitionFailed'))
      await loadRegistry()
    } finally {
      setPendingAction((current) => current === actionId ? null : current)
    }
  }, [commitRegistry, isCurrentWorkspace, loadRegistry, pendingWorkspaceId, registry, t, transitionReasons, workspaceId])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.profiles.title')}
        actions={<HeaderMenu route={routes.view.settings('profiles')} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-4xl mx-auto space-y-8">
            {workspaces.length > 0 && workspaceId ? (
              <SettingsCard className="p-4">
                <label className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium">{t('settings.profiles.workspace')}</span>
                  <select
                    value={workspaceId}
                    disabled={pendingWorkspaceId !== null || isAnalyzing || pendingAction !== null}
                    aria-label={t('settings.profiles.workspace')}
                    onChange={(event) => void handleWorkspaceChange(event.target.value)}
                    className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                    ))}
                  </select>
                </label>
              </SettingsCard>
            ) : (
              <SettingsCard className="p-5 text-sm text-muted-foreground">
                {t('settings.profiles.noWorkspace')}
              </SettingsCard>
            )}

            <SettingsCard className="p-4 border border-border/60">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="space-y-1">
                  <div className="text-sm font-medium">{t('settings.profiles.safetyTitle')}</div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('settings.profiles.safetyDescription')}
                  </p>
                </div>
              </div>
            </SettingsCard>

            <SettingsSection
              title={t('settings.profiles.analysisTitle')}
              description={t('settings.profiles.analysisDescription')}
              action={(
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingWorkspaceId !== null || !workspaceId || isAnalyzing || pendingAction !== null}
                  onClick={() => void handleAnalyze()}
                >
                  {isAnalyzing
                    ? <Loader2 className="animate-spin" />
                    : <RefreshCw />}
                  {isAnalyzing ? t('settings.profiles.analyzing') : t('settings.profiles.analyze')}
                </Button>
              )}
            >
              {!analysis ? (
                <SettingsCard className="p-5 text-sm text-muted-foreground">
                  {t('settings.profiles.analysisEmpty')}
                </SettingsCard>
              ) : (
                <div className="space-y-3">
                  <SettingsCard className="p-4">
                    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                      <span>{t('settings.profiles.analyzedMissions', { count: analysis.analyzedMissionIds.length })}</span>
                      <span>{t('settings.profiles.excludedMissions', { count: analysis.excludedMissionCount })}</span>
                      <span>{new Date(analysis.generatedAt).toLocaleString(i18n.resolvedLanguage)}</span>
                    </div>
                  </SettingsCard>
                  {analysis.report.proposals.length === 0 ? (
                    <SettingsCard className="p-5 text-sm text-muted-foreground">
                      {t('settings.profiles.noOpportunities')}
                    </SettingsCard>
                  ) : analysis.report.proposals.map((proposal) => {
                    const drafted = proposalAlreadyDrafted(registry, proposal)
                    const canCreate = proposal.category === 'agent-profile' && !drafted
                    return (
                      <SettingsCard key={proposal.proposalId} className="p-4">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-sm">{proposal.family}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {t('settings.profiles.supportSummary', {
                                  supporting: proposal.supportingRootMissionCount,
                                  total: proposal.rootMissionCount,
                                })}
                              </div>
                            </div>
                            <Badge variant="secondary">{t(CATEGORY_LABEL_KEYS[proposal.category])}</Badge>
                          </div>
                          <div className="flex justify-end">
                            {proposal.category === 'agent-profile' ? (
                              <Button
                                size="sm"
                                disabled={pendingWorkspaceId !== null || !canCreate || pendingAction !== null || !registry}
                                onClick={() => void handleCreateDraft(proposal)}
                              >
                                {pendingAction === `${workspaceGeneration.current}:proposal:${proposal.proposalId}`
                                  && <Loader2 className="animate-spin" />}
                                {drafted ? t('settings.profiles.draftExists') : t('settings.profiles.createDraft')}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t('settings.profiles.recommendationOnly')}
                              </span>
                            )}
                          </div>
                        </div>
                      </SettingsCard>
                    )
                  })}
                </div>
              )}
            </SettingsSection>

            <SettingsSection
              title={t('settings.profiles.registryTitle')}
              description={registry
                ? t('settings.profiles.registryDescription', { revision: registry.revision })
                : t('settings.profiles.registryUnavailable')}
            >
              {isLoading ? (
                <SettingsCard className="p-8 flex justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </SettingsCard>
              ) : sortedProfiles.length === 0 ? (
                <SettingsCard className="p-5 text-sm text-muted-foreground">
                  {t('settings.profiles.noProfiles')}
                </SettingsCard>
              ) : (
                <div className="space-y-3">
                  {sortedProfiles.map((profile) => {
                    const version = currentVersion(profile)
                    if (!version) return null
                    const offlineEvaluation = latestOfflineEvaluation(profile)
                    const shadowReady = evaluationPassesShadowGate(offlineEvaluation, version.definition)
                    const transitions = safeTransitionsFrom(profile.currentState)
                    return (
                      <SettingsCard key={profile.id} className="p-4">
                        <div className="space-y-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <div className="rounded-lg bg-foreground/5 p-2">
                                <Bot className="size-4" />
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-sm">{version.definition.displayName}</div>
                                <div className="text-xs text-muted-foreground">
                                  {version.definition.specialty}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">
                                {t('settings.profiles.version', { version: profile.currentVersion })}
                              </Badge>
                              <Badge variant={profile.currentState === 'revoked' ? 'destructive' : 'secondary'}>
                                {t(STATE_LABEL_KEYS[profile.currentState])}
                              </Badge>
                            </div>
                          </div>

                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {version.definition.objective}
                          </p>

                          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                            <span>{t('settings.profiles.role')}: {version.definition.role}</span>
                            <span>{t('settings.profiles.risk')}: {version.definition.riskClass}</span>
                            <span>{t('settings.profiles.capabilities')}: {version.definition.requestedCapabilities.length}</span>
                          </div>

                          {transitions.length > 0 && (
                            <div className="space-y-3 border-t border-border/50 pt-3">
                              <Input
                                value={transitionReasons[profile.id] ?? ''}
                                onChange={(event) => setTransitionReasons((current) => ({
                                  ...current,
                                  [profile.id]: event.target.value,
                                }))}
                                placeholder={t('settings.profiles.reasonPlaceholder')}
                                aria-label={t('settings.profiles.reason')}
                                disabled={pendingWorkspaceId !== null || pendingAction !== null}
                              />
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                {!shadowReady && transitions.includes('shadow') && (
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <AlertTriangle className="size-3.5" />
                                    {t('settings.profiles.shadowBlocked')}
                                  </span>
                                )}
                                <div className="ml-auto flex flex-wrap justify-end gap-2">
                                  {transitions.map((to) => {
                                    const shadowBlocked = to === 'shadow' && !shadowReady
                                    const actionId = `${workspaceGeneration.current}:profile:${profile.id}:${to}`
                                    return (
                                      <Button
                                        key={to}
                                        size="sm"
                                        variant={to === 'revoked' ? 'destructive' : 'outline'}
                                        disabled={pendingWorkspaceId !== null || pendingAction !== null || shadowBlocked || !(transitionReasons[profile.id]?.trim())}
                                        onClick={() => void handleTransition(profile, to)}
                                      >
                                        {pendingAction === actionId && <Loader2 className="animate-spin" />}
                                        {t('settings.profiles.transitionTo', { state: t(STATE_LABEL_KEYS[to]) })}
                                      </Button>
                                    )
                                  })}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </SettingsCard>
                    )
                  })}
                </div>
              )}
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
