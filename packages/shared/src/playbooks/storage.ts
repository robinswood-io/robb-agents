import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { validatePlaybookManifest } from './validation.ts'
import type { LoadedPlaybook } from './types.ts'

const cache = new Map<string, LoadedPlaybook[]>()

/** Playbooks are workspace-scoped, versioned Markdown files. */
export function getWorkspacePlaybooksPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'playbooks')
}

export function invalidatePlaybooksCache(workspaceRootPath?: string): void {
  if (workspaceRootPath) cache.delete(workspaceRootPath)
  else cache.clear()
}

function loadPlaybook(path: string): LoadedPlaybook | null {
  try {
    const parsed = matter(readFileSync(path, 'utf8'))
    const manifest = validatePlaybookManifest(parsed.data)
    const instructions = parsed.content.trim()
    if (!instructions) return null
    return { manifest, instructions, path }
  } catch {
    return null
  }
}

export function loadWorkspacePlaybooks(workspaceRootPath: string): LoadedPlaybook[] {
  const cached = cache.get(workspaceRootPath)
  if (cached) return cached
  const dir = getWorkspacePlaybooksPath(workspaceRootPath)
  if (!existsSync(dir)) return []
  const loaded = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => loadPlaybook(join(dir, entry.name)))
    .filter((item): item is LoadedPlaybook => item !== null)
    .filter((item, index, all) => all.findIndex(other => other.manifest.slug === item.manifest.slug) === index)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  cache.set(workspaceRootPath, loaded)
  return loaded
}

export function loadWorkspacePlaybook(workspaceRootPath: string, slug: string): LoadedPlaybook | null {
  return loadWorkspacePlaybooks(workspaceRootPath).find(playbook => playbook.manifest.slug === slug) ?? null
}
