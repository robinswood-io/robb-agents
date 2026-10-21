import { join, resolve, sep } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { RPC_CHANNELS, type SkillFile } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { assertRequestWorkspaceAccess, type RpcServer } from '@craft-agent/server-core/transport'
import { getWorkspaceAllowedDirs } from '../utils'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(RPC_CHANNELS.skills.GET, async (ctx, workspaceId: string, workingDirectory?: string) => {
    deps.platform.logger?.info(`SKILLS_GET: Loading skills for workspace: ${workspaceId}${workingDirectory ? `, workingDirectory: ${workingDirectory}` : ''}`)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      assertRequestWorkspaceAccess(ctx, workspaceId)
      deps.platform.logger?.error(`SKILLS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)
    // Validate workingDirectory exists on this server — a thin client may pass
    // its local path which doesn't exist on the remote server's filesystem.
    // For restricted principals (e.g. remote-device), workingDirectory must stay within allowed workspace dirs.
    let effectiveWorkingDir = workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined
    if (effectiveWorkingDir && ctx?.allowedWorkspaceIds && ctx.allowedWorkspaceIds !== '*') {
      const resolvedWorkingDir = resolve(effectiveWorkingDir)
      const allowedDirs = getWorkspaceAllowedDirs(workspace.id)
      const withinAllowed = allowedDirs.some(dir => {
        const resolvedAllowed = resolve(dir)
        const prefix = resolvedAllowed.endsWith(sep) ? resolvedAllowed : `${resolvedAllowed}${sep}`
        return resolvedWorkingDir === resolvedAllowed || resolvedWorkingDir.startsWith(prefix)
      })
      if (!withinAllowed) {
        effectiveWorkingDir = undefined
      }
    }
    const { loadAllSkills } = await import('@craft-agent/shared/skills')
    const skills = loadAllSkills(workspace.rootPath, effectiveWorkingDir)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`)
    return skills
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      assertRequestWorkspaceAccess(ctx, workspaceId)
      deps.platform.logger?.error(`SKILLS_GET_FILES: Workspace not found: ${workspaceId}`)
      return []
    }
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')
    const { resolveSkillDir } = await import('@craft-agent/shared/skills')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = resolveSkillDir(skillsDir, skillSlug)

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.')) // Skip hidden files
          .map(entry => {
            const fullPath = join(dirPath, entry.name)
            if (entry.isDirectory()) {
              return {
                name: entry.name,
                type: 'directory' as const,
                children: scanDirectory(fullPath),
              }
            } else {
              const stats = statSync(fullPath)
              return {
                name: entry.name,
                type: 'file' as const,
                size: stats.size,
              }
            }
          })
          .sort((a, b) => {
            // Directories first, then files
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        deps.platform.logger?.error(`SKILLS_GET_FILES: Error scanning ${dirPath}:`, err)
        return []
      }
    }

    return scanDirectory(skillDir)
  })

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { deleteSkill } = await import('@craft-agent/shared/skills')
    deleteSkill(workspace.rootPath, skillSlug)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
  })

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)
    if (workspace.remoteServer) throw new Error('Open in editor is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')
    const { resolveSkillDir } = await import('@craft-agent/shared/skills')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillFile = join(resolveSkillDir(skillsDir, skillSlug), 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)
    if (workspace.remoteServer) throw new Error('Show in Finder is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@craft-agent/shared/workspaces')
    const { resolveSkillDir } = await import('@craft-agent/shared/skills')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = resolveSkillDir(skillsDir, skillSlug)
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
