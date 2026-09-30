import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSessionAtomically,
  ensureSessionDir,
  getSessionPath,
  purgeSessionDeletionQuarantine,
} from '../storage.ts'

const roots: string[] = []

function fixtureRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `robb-atomic-delete-${label}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('atomic session deletion storage', () => {
  it('commits by rename and removes the complete live directory', () => {
    const root = fixtureRoot('success')
    const id = 'atomic-success'
    const sessionPath = ensureSessionDir(root, id)
    writeFileSync(join(sessionPath, 'attachment.pdf'), Buffer.from([0, 1, 2, 255]))

    const result = deleteSessionAtomically(root, id)

    expect(result.committed).toBe(true)
    expect(result.durable).toBe(process.platform !== 'win32')
    expect(existsSync(sessionPath)).toBe(false)
    // Windows cannot attest directory-fsync durability, but logical purge must
    // still finish instead of leaving a permanently cached residual entry.
    expect(readdirSync(root).some((name) => name.startsWith('.robb-agents-session-deletion-v1-')))
      .toBe(false)
  })

  it('fails closed and preserves the moved inode when the source reappears after rename', () => {
    const root = fixtureRoot('source-reappears')
    const id = 'source-reappears'
    const original = ensureSessionDir(root, id)
    writeFileSync(join(original, 'original.txt'), 'original transcript')

    const result = deleteSessionAtomically(root, id, {
      afterRename: ({ sourcePath }) => {
        const recreated = ensureSessionDir(root, id)
        expect(existsSync(sourcePath)).toBe(true)
        writeFileSync(join(recreated, 'late.txt'), 'late writer')
      },
    })

    expect(result).toEqual({ committed: false, durable: false, failureReason: 'unsafe-path' })
    expect(readFileSync(join(getSessionPath(root, id), 'late.txt'), 'utf8')).toBe('late writer')
    const pending = readdirSync(root).filter((name) => (
      name.startsWith('.robb-agents-session-deletion-pending-v1-')
    ))
    expect(pending).toHaveLength(1)
    expect(readFileSync(join(root, pending[0]!, 'original.txt'), 'utf8')).toBe('original transcript')
  })

  it('rejects dangling session links without touching their targets', () => {
    if (process.platform === 'win32') return
    const root = fixtureRoot('symlinks')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const dangling = getSessionPath(root, 'dangling-session')
    symlinkSync(join(root, 'missing-target'), dangling, 'dir')

    expect(deleteSessionAtomically(root, 'dangling-session'))
      .toEqual({ committed: false, durable: false, failureReason: 'unsafe-path' })
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
  })

  it('never traverses a replaceable legacy quarantine symlink during commit', () => {
    if (process.platform === 'win32') return
    const root = fixtureRoot('quarantine-link')
    const live = ensureSessionDir(root, 'quarantine-link')
    const attachment = join(live, 'attachment.bin')
    writeFileSync(attachment, Buffer.from([9, 8, 7, 0, 6]))
    const outside = join(root, 'outside-quarantine')
    mkdirSync(outside)
    writeFileSync(join(outside, 'proof.txt'), 'untouched')
    symlinkSync(outside, join(root, '.session-deletions'), 'dir')

    expect(deleteSessionAtomically(root, 'quarantine-link'))
      .toEqual({ committed: true, durable: true })
    expect(existsSync(live)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(join(outside, 'proof.txt'), 'utf8')).toBe('untouched')
    expect(readdirSync(outside)).toEqual(['proof.txt'])
  })

  it('rejects invalid identifiers before constructing a quarantine path', () => {
    const root = fixtureRoot('invalid-id')
    expect(() => deleteSessionAtomically(root, '../escape')).toThrow('Security Error')
    expect(existsSync(join(root, '.session-deletions'))).toBe(false)
  })

  it('purges only strictly named v4 residual entries, including the legacy layout', () => {
    const root = fixtureRoot('purge')
    const quarantine = join(root, '.session-deletions')
    const uuid = '12345678-1234-4abc-8def-123456789abc'
    const looseUuid = '12345678-1234-1abc-1def-123456789abc'
    const owned = join(quarantine, `${'a'.repeat(64)}-${uuid}`)
    const looselyNamedLegacy = join(quarantine, `${'b'.repeat(64)}-${looseUuid}`)
    const directOwned = join(root, `.robb-agents-session-deletion-v1-${'c'.repeat(64)}-${uuid}`)
    const looselyNamedDirect = join(root, `.robb-agents-session-deletion-v1-${'d'.repeat(64)}-${looseUuid}`)
    const unrelated = join(quarantine, 'keep-me')
    mkdirSync(owned, { recursive: true })
    mkdirSync(looselyNamedLegacy, { recursive: true })
    mkdirSync(directOwned)
    mkdirSync(looselyNamedDirect)
    writeFileSync(join(owned, 'stale'), 'data')
    writeFileSync(unrelated, 'data')

    expect(purgeSessionDeletionQuarantine(root)).toBe(true)
    expect(existsSync(owned)).toBe(false)
    expect(existsSync(directOwned)).toBe(false)
    expect(existsSync(looselyNamedLegacy)).toBe(true)
    expect(existsSync(looselyNamedDirect)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('recovers a legacy quarantine isolated by an interrupted earlier purge', () => {
    const root = fixtureRoot('legacy-staging-recovery')
    const uuid = '12345678-1234-4abc-8def-123456789abc'
    const staging = join(root, `.robb-agents-session-deletion-legacy-v1-${uuid}`)
    const owned = join(staging, `${'e'.repeat(64)}-${uuid}`)
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'stale'), 'data')

    expect(purgeSessionDeletionQuarantine(root)).toBe(true)
    expect(existsSync(staging)).toBe(false)
  })

  it('refuses a legacy quarantine symlink without touching its target', () => {
    if (process.platform === 'win32') return
    const root = fixtureRoot('purge-symlink')
    const quarantine = join(root, '.session-deletions')
    rmSync(quarantine, { recursive: true, force: true })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'proof.txt'), 'untouched')
    const targetOwned = join(
      outside,
      `${'f'.repeat(64)}-12345678-1234-4abc-8def-123456789abc`,
    )
    mkdirSync(targetOwned)
    writeFileSync(join(targetOwned, 'proof.txt'), 'also untouched')
    symlinkSync(outside, quarantine, 'dir')
    expect(purgeSessionDeletionQuarantine(root)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(join(outside, 'proof.txt'), 'utf8')).toBe('untouched')
    expect(readFileSync(join(targetOwned, 'proof.txt'), 'utf8')).toBe('also untouched')
  })
})
