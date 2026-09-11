import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreFiles } from '../bundle-files'

let root: string
let target: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundle-confinement-'))
  target = join(root, 'target'); outside = join(root, 'outside')
  mkdirSync(target); mkdirSync(outside)
  writeFileSync(join(outside, 'file.txt'), 'private original')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const file = (relativePath: string) => ({ relativePath, contentBase64: Buffer.from('replacement').toString('base64'), size: 11 })

describe('bundle restoration filesystem confinement', () => {
  test('rejects a symlinked parent without writing outside the root', () => {
    symlinkSync(outside, join(target, 'linked'), 'junction')
    expect(() => restoreFiles(target, [file('linked/file.txt')])).toThrow()
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('private original')
  })
  test('rejects a symlinked destination before truncating it', () => {
    symlinkSync(join(outside, 'file.txt'), join(target, 'file.txt'), 'file')
    expect(() => restoreFiles(target, [file('file.txt')])).toThrow()
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('private original')
  })
  test('rejects a hard-linked destination before truncating it', () => {
    linkSync(join(outside, 'file.txt'), join(target, 'file.txt'))
    expect(() => restoreFiles(target, [file('file.txt')])).toThrow()
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('private original')
  })
  test('preserves nested creation and replacement of ordinary files', () => {
    restoreFiles(target, [file('nested/file.txt')])
    expect(readFileSync(join(target, 'nested/file.txt'), 'utf8')).toBe('replacement')
    writeFileSync(join(target, 'nested/file.txt'), 'a longer previous file')
    restoreFiles(target, [file('nested/file.txt')])
    expect(readFileSync(join(target, 'nested/file.txt'), 'utf8')).toBe('replacement')
  })
})
