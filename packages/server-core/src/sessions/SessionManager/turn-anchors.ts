import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { PI_TURN_ANCHORS_VERSION } from './runtime-policy.ts';

const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

interface PiTurnAnchorsIndex {
  version: number
  anchors: Record<string, string>
}

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(
  sessionPath: string,
  assertDestination?: () => void,
): Promise<PiTurnAnchorsIndex> {
  assertDestination?.()
  const filePath = getPiTurnAnchorsPath(sessionPath)
  let result: PiTurnAnchorsIndex
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PiTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(anchors)) {
      if (typeof messageId === 'string' && typeof anchor === 'string' && messageId && anchor) {
        normalized[messageId] = anchor
      }
    }
    result = {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    result = {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
  assertDestination?.()
  return result
}

export async function getPiTurnAnchor(
  sessionPath: string,
  messageId: string,
  assertDestination?: () => void,
): Promise<string | undefined> {
  if (!messageId) return undefined
  const index = await loadPiTurnAnchors(sessionPath, assertDestination)
  return index.anchors[messageId]
}

export async function savePiTurnAnchor(
  sessionPath: string,
  messageId: string,
  anchorId: string,
  assertDestination?: () => void,
): Promise<void> {
  if (!messageId || !anchorId) return

  const index = await loadPiTurnAnchors(sessionPath, assertDestination)
  if (index.anchors[messageId] === anchorId) return

  index.anchors[messageId] = anchorId

  const filePath = getPiTurnAnchorsPath(sessionPath)
  assertDestination?.()
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  assertDestination?.()
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
  assertDestination?.()
}

/**
 * Copy Pi turn anchors from the source session into the branch session,
 * filtered to the messages actually carried into the branch.
 *
 * Without this, branching a branch is silently lossy: the source branch's
 * sidecar contains no anchors for messages copied from its own parent, so a
 * downstream branch falls back to "full-history fork" — discarding the
 * branch cutoff and producing a session whose visible history doesn't match
 * what the LLM sees. See craft-agents-oss#782.
 */
export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
  assertSourceDestination?: () => void,
): Promise<void> {
  const index = await loadPiTurnAnchors(sourceSessionPath, assertSourceDestination)
  if (Object.keys(index.anchors).length === 0) return
  const idSet = new Set(branchedMessageIds)
  const filtered: Record<string, string> = {}
  for (const [messageId, anchor] of Object.entries(index.anchors)) {
    if (idSet.has(messageId)) {
      filtered[messageId] = anchor
    }
  }
  if (Object.keys(filtered).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(
    getPiTurnAnchorsPath(branchSessionPath),
    JSON.stringify({ version: PI_TURN_ANCHORS_VERSION, anchors: filtered }),
    'utf-8',
  )
}

const CLAUDE_TURN_ANCHORS_VERSION = 1

const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

export function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(
  sessionPath: string,
  assertDestination?: () => void,
): Promise<ClaudeTurnAnchorsIndex> {
  assertDestination?.()
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  let result: ClaudeTurnAnchorsIndex
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      const sdkSessionId = (value as { sdkSessionId?: unknown }).sdkSessionId
      const sdkMessageUuid = (value as { sdkMessageUuid?: unknown }).sdkMessageUuid
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    result = {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    result = {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
  assertDestination?.()
  return result
}

export async function getClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  assertDestination?: () => void,
): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath, assertDestination)
  return index.anchors[messageId]
}

export async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
  assertDestination?: () => void,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath, assertDestination)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  assertDestination?.()
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  assertDestination?.()
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
  assertDestination?.()
}
