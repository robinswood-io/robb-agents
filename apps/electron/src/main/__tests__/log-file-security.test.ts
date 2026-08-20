import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensurePrivateLogDirectory,
  ensurePrivateLogFilePath,
  sanitizeExistingLogFile,
} from '../log-file-security'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('ensurePrivateLogFilePath', () => {
  it('hardens an existing permissive log and its directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-log-security-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    const logPath = join(logDirectory, 'main.log')
    ensurePrivateLogFilePath(logPath)
    writeFileSync(logPath, 'diagnostic', { mode: 0o644 })

    expect(ensurePrivateLogFilePath(logPath)).toBe(true)
    expect(statSync(logDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(logPath).mode & 0o777).toBe(0o600)
  })

  it('hardens all regular files in the log directory without following symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-log-directory-security-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    const outsideFile = join(root, 'outside.log')
    mkdirSync(logDirectory, { mode: 0o755 })
    writeFileSync(join(logDirectory, 'main.log'), 'main', { mode: 0o644 })
    writeFileSync(join(logDirectory, 'robb-remote-tunnel-launch.log'), 'tunnel', { mode: 0o644 })
    writeFileSync(outsideFile, 'outside', { mode: 0o644 })
    symlinkSync(outsideFile, join(logDirectory, 'linked.log'))

    expect(ensurePrivateLogDirectory(logDirectory)).toEqual({
      success: true,
      hardenedFileCount: 2,
    })
    expect(statSync(logDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(join(logDirectory, 'main.log')).mode & 0o777).toBe(0o600)
    expect(statSync(join(logDirectory, 'robb-remote-tunnel-launch.log')).mode & 0o777).toBe(0o600)
    expect(statSync(outsideFile).mode & 0o777).toBe(0o644)
  })

  it('atomically redacts an existing log without following symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-log-redaction-'))
    roots.push(root)
    const logPath = join(root, 'main.log')
    const outsideFile = join(root, 'outside.log')
    const linkedFile = join(root, 'linked.log')
    writeFileSync(logPath, 'callback?code=secret-code&state=secret-state\n', { mode: 0o644 })
    writeFileSync(outsideFile, 'code=must-stay\n', { mode: 0o644 })
    symlinkSync(outsideFile, linkedFile)

    expect(sanitizeExistingLogFile(
      logPath,
      content => content.replaceAll(/secret-[a-z]+/g, '[REDACTED]'),
    )).toEqual({ success: true, changed: true })
    expect(readFileSync(logPath, 'utf8')).toBe('callback?code=[REDACTED]&state=[REDACTED]\n')
    expect(statSync(logPath).mode & 0o777).toBe(0o600)

    expect(sanitizeExistingLogFile(linkedFile, () => 'changed'))
      .toEqual({ success: true, changed: false })
    expect(readFileSync(outsideFile, 'utf8')).toBe('code=must-stay\n')
  })
})
