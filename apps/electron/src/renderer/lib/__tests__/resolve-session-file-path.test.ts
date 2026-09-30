import { describe, expect, it } from 'bun:test'
import { resolveSessionFilePath } from '../resolve-session-file-path'

describe('session document paths', () => {
  it('keeps explicit local roots and Unicode unchanged', () => {
    for (const path of ['/tmp/Compte rendu été.pdf', '~/Documents/rapport.pdf', 'C:/Docs/report.pdf']) {
      expect(resolveSessionFilePath(path, '/workspace')).toBe(path)
    }
  })
  it('uses the actual session directory before workspace fallback', () => {
    expect(resolveSessionFilePath('./data/Compte rendu été.pdf', '/session/', '/workspace'))
      .toBe('/session/data/Compte rendu été.pdf')
    expect(resolveSessionFilePath('../rapport.pdf', '/session/data')).toBe('/session/data/../rapport.pdf')
    expect(resolveSessionFilePath('rapport.pdf', undefined, '/workspace')).toBe('/workspace/rapport.pdf')
    expect(resolveSessionFilePath('rapport.pdf')).toBe('rapport.pdf')
  })
})
