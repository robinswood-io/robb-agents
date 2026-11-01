import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';

import { assertRequestWorkspaceAccess, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";



export function registerWorkspaceImageHandlers(server: RpcServer, deps: HandlerDeps): void {

  // ============================================================
  // Workspace Image Read/Write
  // ============================================================

  // Generic workspace image loading (for source icons, status icons, etc.)
  server.handle(RPC_CHANNELS.workspace.READ_IMAGE, async (ctx, workspaceId: string, relativePath: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { readFileSync, existsSync, realpathSync } = await import('fs')
    const { resolve, sep } = await import('path')

    // Security: validate path
    // - Must not contain .. (path traversal) or null bytes
    // - Must be a valid image extension
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif']

    if (typeof relativePath !== 'string' || relativePath.includes('..') || relativePath.includes('\0')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root with trailing separator check
    const workspaceRoot = resolve(workspace.rootPath)
    const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
    const absolutePath = resolve(workspaceRoot, relativePath)

    // Double-check the resolved path is strictly within workspace
    if (!absolutePath.startsWith(workspacePrefix)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    if (!existsSync(absolutePath)) {
      return null  // Missing optional files - silent fallback to default icons
    }

    // Resolve symlinks to prevent symlink escape outside workspace
    try {
      const realTarget = realpathSync(absolutePath)
      const realRoot = realpathSync(workspaceRoot)
      const realPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
      if (!realTarget.startsWith(realPrefix)) {
        throw new Error('Invalid path: outside workspace directory')
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid path:')) throw err
      return null
    }

    // Read file as buffer
    const buffer = readFileSync(absolutePath)

    // If SVG, return as UTF-8 string (caller will use as innerHTML)
    if (ext === '.svg') {
      return buffer.toString('utf-8')
    }

    // For binary images, return as data URL
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.gif': 'image/gif',
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  })

  // Generic workspace image writing (for workspace icon, etc.)
  // Resizes images to max 256x256 to keep file sizes small
  server.handle(RPC_CHANNELS.workspace.WRITE_IMAGE, async (ctx, workspaceId: string, relativePath: string, base64: string, mimeType: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { writeFileSync, existsSync, unlinkSync, readdirSync, realpathSync, lstatSync } = await import('fs')
    const { join, resolve, sep, basename, dirname } = await import('path')

    // Security: validate path
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']

    if (typeof relativePath !== 'string' || relativePath.includes('..') || relativePath.includes('\0')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root with trailing separator check
    const workspaceRoot = resolve(workspace.rootPath)
    const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
    const absolutePath = resolve(workspaceRoot, relativePath)

    // Double-check the resolved path is strictly within workspace
    if (!absolutePath.startsWith(workspacePrefix)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    // Prevent writing through a symlinked file or symlinked parent directory outside workspace
    if (existsSync(workspaceRoot)) {
      const realRoot = realpathSync(workspaceRoot)
      const realPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
      const parentDir = dirname(absolutePath)
      if (existsSync(parentDir)) {
        const realParent = realpathSync(parentDir)
        if (realParent !== realRoot && !realParent.startsWith(realPrefix)) {
          throw new Error('Invalid path: outside workspace directory')
        }
      }
      if (existsSync(absolutePath)) {
        if (lstatSync(absolutePath).isSymbolicLink()) {
          throw new Error('Invalid path: refusing to overwrite symbolic link')
        }
      }
    }

    // If this is an icon file (icon.*), delete any existing icon files with different extensions
    const fileName = basename(relativePath)
    if (fileName.startsWith('icon.')) {
      const files = readdirSync(workspace.rootPath)
      for (const file of files) {
        if (file.startsWith('icon.') && file !== fileName) {
          const oldPath = join(workspace.rootPath, file)
          try {
            unlinkSync(oldPath)
          } catch {
            // Ignore errors deleting old icon
          }
        }
      }
    }

    // Decode base64 to buffer
    const buffer = Buffer.from(base64, 'base64')

    // For SVGs, just write directly (no resizing needed)
    if (mimeType === 'image/svg+xml' || ext === '.svg') {
      writeFileSync(absolutePath, buffer)
      return
    }

    // For raster images, resize to max 256x256
    const metadata = await deps.platform.imageProcessor.getMetadata(buffer)
    const width = metadata?.width ?? 0
    const height = metadata?.height ?? 0

    // Only resize if larger than 256px
    if (width > 256 || height > 256) {
      const resized = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 256, height: 256 },
        format: 'png',
      })
      writeFileSync(absolutePath, resized)
    } else {
      // Small enough, write as-is
      writeFileSync(absolutePath, buffer)
    }
  })
}
