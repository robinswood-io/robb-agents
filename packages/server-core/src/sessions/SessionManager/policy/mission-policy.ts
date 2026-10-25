import { agentDeliveryId } from "../../agent-delivery.ts";
import { isDeepStrictEqual } from "node:util";
import { readRunLog } from "@craft-agent/shared/tasks";
import { loadMissionSnapshot } from "@craft-agent/shared/missions";
import { type Workspace } from "@craft-agent/shared/config";
import { type MissionCapabilityLock } from "@craft-agent/shared/sessions";
import { loadWorkspaceSources, type LoadedSource, getSourceCredentialManager } from "@craft-agent/shared/sources";
import { McpClientPool } from "@craft-agent/shared/mcp";
import { type Message } from "@craft-agent/core/types";
import { redactSecretLikeMaterial } from "@craft-agent/shared/utils";
import { loadAllSkills } from "@craft-agent/shared/skills";
import {
  loadSpecializedSkillPackageSnapshot,
  specializedSourceCapabilityBindingFromSnapshot,
} from "../../../specialized-profiles/capability-identity.ts";
import { canonicalMissionWorkingDirectory } from "../../../missions/mission-workspace-path.ts";
import { extractAuthenticatedTaskText, type AuthenticatedTaskEnvelope } from "@craft-agent/shared/config";
import type { ManagedSession } from "../managed-session.ts";
import type { MissionLiveToolDefinition, MissionSourceToolCatalogDecision } from "../mission-route.ts";
import {
  assertValidOrdinaryMissionRouteLock,
  canonicalMissionSourceSlugs,
  hasMissionDispatchTriplet,
} from "../mission-route.ts";
import { sessionLog } from "../runtime-platform.ts";
import { DELEGATED_TERMINAL_RESULT_PROTOCOL } from "../runtime-policy.ts";
import type { BuildServersFromSourcesOptions } from "../source-build.ts";

/** Stable across retries/restarts and independent of mutable final prose. */
export function delegatedTerminalResultDeliveryId(parent: ManagedSession, child: ManagedSession): string | undefined {
    const delegation = child.delegation
    if (!delegation || child.parentSessionId !== parent.id) return undefined
    const childObjectiveId = child.activeObjective?.objectiveId
      ?? child.activeObjective?.userMessageId
      ?? 'dispatch'
    return agentDeliveryId(
      child.id,
      delegation.parentObjectiveId,
      parent.id,
      `${DELEGATED_TERMINAL_RESULT_PROTOCOL}:${child.id}:${childObjectiveId}`,
    )
  }

export function delegatedTerminalResultContent(child: ManagedSession): string {
    const objectiveState = child.activeObjective?.terminalState
      ?? (child.delegation?.finishedAt ? 'dispatch_failed' : 'unknown')
    const finalAssistant = child.messages.findLast(message => (
      message.role === 'assistant' && !message.isIntermediate
    ))
    const terminalError = child.messages.findLast(message => message.role === 'error')
    const failureTerminalState = objectiveState === 'dispatch_failed'
      || objectiveState === 'exhausted'
      || objectiveState === 'blocked_policy'
      || objectiveState === 'blocked_human'
    const terminalOutput = failureTerminalState && terminalError
      ? terminalError
      : !finalAssistant ? terminalError
        : !terminalError ? finalAssistant
          : terminalError.timestamp >= finalAssistant.timestamp ? terminalError : finalAssistant
    const resultText = terminalOutput?.content
      ?? 'The delegated session ended without a final assistant message. Inspect its durable transcript before deciding the parent outcome.'
    const envelope = {
      schemaVersion: 1,
      childSessionId: child.id,
      childObjectiveId: child.activeObjective?.objectiveId ?? child.activeObjective?.userMessageId,
      parentObjectiveId: child.delegation?.parentObjectiveId,
      role: child.delegation?.role,
      state: objectiveState,
    }
    return `${DELEGATED_TERMINAL_RESULT_PROTOCOL}\n${JSON.stringify(envelope)}\n\n${resultText.slice(0, 32_000)}`
  }

export async function discoverMissionToolCatalog(
    workspace: Workspace,
    sourceSlug: string,
    mcpServers: Parameters<McpClientPool['sync']>[0],
    apiServers: NonNullable<Parameters<McpClientPool['sync']>[1]> = {},
  ): Promise<MissionSourceToolCatalogDecision> {
    const catalog = new McpClientPool({ workspaceRootPath: workspace.rootPath })
    try {
      const failedSlugs = await catalog.sync(mcpServers, apiServers)
      if (failedSlugs.includes(sourceSlug)) {
        sessionLog.warn('Mission source failed live tool discovery', { sourceSlug })
        return {
          allowed: false,
          reason: `Mission source "${sourceSlug}" failed live tool discovery (MISSION_SOURCE_CATALOG_DISCOVERY_FAILED)`,
        }
      }
      const tools = new Map<string, MissionLiveToolDefinition>()
      for (const tool of catalog.getTools(sourceSlug)) {
        const proxyName = catalog.getProxyToolName(sourceSlug, tool.name)
        if (!proxyName) continue
        tools.set(proxyName, {
          // Keep the exact live schema rather than the backend projection,
          // which deliberately strips metadata such as `$schema`.
          inputSchema: tool.inputSchema,
          capabilities: {
            readOnly: tool.annotations?.readOnlyHint === true,
            idempotent: tool.annotations?.idempotentHint === true,
            destructive: tool.annotations?.destructiveHint === true,
            openWorld: tool.annotations?.openWorldHint === true,
            trusted: false,
          },
        })
      }
      return { allowed: true, tools }
    } catch (error) {
      sessionLog.warn('Mission source live tool discovery threw', {
        sourceSlug,
        error: redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4_000),
      })
      return {
        allowed: false,
        reason: `Mission source "${sourceSlug}" live tool discovery failed (MISSION_SOURCE_CATALOG_DISCOVERY_FAILED)`,
      }
    } finally {
      try {
        await catalog.disconnectAll()
      } catch (error) {
        sessionLog.warn('Mission source temporary catalog cleanup failed', {
          sourceSlug,
          error: redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        })
      }
    }
  }

export function loadSpecializedMissionSkillPackages(
    managed: ManagedSession,
    lock: MissionCapabilityLock,
  ): Array<{ slug: string; name: string; content: string }> {
    return lock.capabilities.filter(({ kind }) => kind === 'skill').map((capability) => {
      const snapshot = loadSpecializedSkillPackageSnapshot({
        workspaceRoot: managed.workspace.rootPath,
        workingDirectory: managed.workingDirectory,
        slug: capability.name,
      })
      if (!snapshot || snapshot.identitySha256 !== capability.identitySha256) {
        throw new Error(`Specialized Mission skill capability "${capability.name}" drifted`)
      }
      return { slug: snapshot.slug, name: snapshot.name, content: snapshot.content }
    })
  }

export function assertSpecializedMissionSourceSelection(
    managed: ManagedSession,
    sourceSlugs: readonly string[],
  ): void {
    const lock = managed.missionCapabilityLock
    if (!lock) return
    const declared = new Set(lock.capabilities
      .filter(({ kind }) => kind === 'source')
      .map(({ name }) => name))
    for (const slug of sourceSlugs) {
      if (!declared.has(slug)) {
        throw new Error(`Specialized Mission source capability "${slug}" is not declared`)
      }
    }
  }

export async function captureSpecializedMissionSourceSnapshot(
    managed: ManagedSession,
    sources: readonly LoadedSource[],
  ): Promise<LoadedSource[]> {
    const lock = managed.missionCapabilityLock
    if (!lock) return structuredClone([...sources])
    const credentialManager = getSourceCredentialManager()
    for (const source of sources) {
      const expected = lock.capabilities.find(capability =>
        capability.kind === 'source' && capability.name === source.config.slug)
      if (!expected) {
        throw new Error(`Specialized Mission source capability "${source.config.slug}" is not declared`)
      }
      const bound = await credentialManager.loadWithIdentity(source)
      const actual = specializedSourceCapabilityBindingFromSnapshot(source, bound)
      if (actual.identitySha256 !== expected.identitySha256
        || actual.authorityBindingId !== expected.authorityBindingId) {
        throw new Error(`Specialized Mission source capability "${source.config.slug}" drifted`)
      }
    }
    return structuredClone([...sources])
  }

/**
   * Authenticate every Mission session against its exact live journal lease,
   * then re-authorize the workspace-relative cwd at point of use. Re-running
   * canonicalMissionWorkingDirectory is intentional: an in-workspace path may
   * have been replaced by an escaping symlink after session creation.
   */
export function assertMissionDispatchWorkingDirectory(
    managed: ManagedSession,
  ): NonNullable<ReturnType<typeof loadMissionSnapshot>> | undefined {
    const missionIdentity = [
      managed.missionId,
      managed.missionWorkItemId,
      managed.missionDispatchId,
    ]
    if (missionIdentity.every(value => !value)) return undefined
    if (!hasMissionDispatchTriplet(managed)) {
      throw new Error('Mission session has an incomplete durable dispatch identity')
    }

    const snapshot = loadMissionSnapshot(managed.workspace.rootPath, managed.missionId!)
    const runtime = snapshot?.workItems[managed.missionWorkItemId!]
    if (!snapshot
      || snapshot.spec.id !== managed.missionId
      || !runtime
      || runtime.status !== 'running'
      || runtime.dispatchId !== managed.missionDispatchId
      || runtime.externalSessionId !== managed.id) {
      throw new Error('Mission session durable dispatch binding is unavailable or drifted')
    }

    const expectedWorkingDirectory = canonicalMissionWorkingDirectory(
      managed.workspace.rootPath,
      snapshot.spec.cwd,
    )
    if (managed.workingDirectory !== expectedWorkingDirectory) {
      throw new Error('Mission session working directory drifted from its durable journal binding')
    }
    return snapshot
  }

/** Synchronous projection fence used immediately before an ordinary Mission chat handoff. */
export function assertOrdinaryMissionRouteProjection(managed: ManagedSession): void {
    const lock = managed.missionOrdinaryRouteLock
    if (!lock) return
    assertValidOrdinaryMissionRouteLock(lock)
    if (managed.missionRouteLockSha256
      || !managed.missionId
      || !managed.missionWorkItemId
      || !managed.missionDispatchId
      || !managed.missionRole
      || managed.llmConnection !== lock.connectionSlug
      || managed.model !== lock.model
      || managed.thinkingLevel !== lock.thinkingLevel
      || managed.workingDirectory !== lock.cwd
      || !isDeepStrictEqual(
        canonicalMissionSourceSlugs(managed.enabledSourceSlugs),
        lock.effectiveSourceSlugs,
      )) {
      throw new Error('Ordinary Mission session route projection is unavailable or drifted')
    }
  }

export function ordinaryMissionSourceBuildOptions(
    managed: ManagedSession,
  ): BuildServersFromSourcesOptions | undefined {
    const bindings = managed.missionOrdinaryRouteLock?.effectiveSourceBindings
    return bindings ? { ordinarySourceBindings: bindings } : undefined
  }

export function authenticatedTaskFor(managed: ManagedSession, message: Pick<Message, 'content' | 'internalOrigin'> | undefined): { authenticatedEnvelope?: AuthenticatedTaskEnvelope; authenticatedTaskText?: string } {
    if (!message) return {};
    const origin = message.internalOrigin;
    if (origin?.kind !== 'spawned-session' || origin.senderSessionId !== managed.parentSessionId) return {};
    if (managed.missionRole === 'planner' && origin.authenticatedTaskText?.trim()) return { authenticatedTaskText: origin.authenticatedTaskText.trim() };
    if (managed.missionId && managed.missionWorkItemId && managed.missionDispatchId) {
      const mission = loadMissionSnapshot(managed.workspace.rootPath, managed.missionId);
      const item = mission?.workItems[managed.missionWorkItemId];
      const marker = '<mission-dispatch id="' + managed.missionDispatchId + '" mission="' + managed.missionId + '" work-item="' + managed.missionWorkItemId + '">';
      if (item?.dispatchId === managed.missionDispatchId && item.externalSessionId === managed.id && message.content.startsWith(marker)) {
        return { authenticatedEnvelope: 'mission-v2', authenticatedTaskText: [mission!.spec.objective, item.definition.prompt ?? item.definition.title].join('\n') };
      }
    }
    if (managed.taskSlug && managed.taskRunId && managed.taskNodeId && readRunLog(managed.workspace.rootPath, managed.taskSlug, managed.taskRunId).some(entry => entry.kind === 'node-spawned' && entry.nodeId === managed.taskNodeId && entry.sessionId === managed.id)) {
      return { authenticatedEnvelope: 'specialist-execution', authenticatedTaskText: origin.authenticatedTaskText?.trim() || extractAuthenticatedTaskText(message.content, 'specialist-execution') };
    }
    return {};
  }

/**
   * Resolve @mentions in automation prompts to source and skill slugs
   */
export function resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }
