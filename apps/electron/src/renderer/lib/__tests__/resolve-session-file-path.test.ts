import { describe, expect, it } from 'bun:test'
import { resolveDocumentFilePath, resolveSessionFilePath } from '../resolve-session-file-path'

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

describe('preview document links', () => {
  it('resolves sibling and parent links from the actual document directory', () => {
    expect(resolveDocumentFilePath('resultat.json', '/qa/été/rapport.md'))
      .toBe('/qa/été/resultat.json')
    expect(resolveDocumentFilePath('./rapport.html', '/qa/été/rapport.md'))
      .toBe('/qa/été/rapport.html')
    expect(resolveDocumentFilePath('../Compte rendu.pdf', '/qa/été/rapport.md'))
      .toBe('/qa/été/../Compte rendu.pdf')
    expect(resolveDocumentFilePath('resultat.json', '/rapport.md')).toBe('/resultat.json')
  })

  it('preserves explicit roots and Windows shares', () => {
    const share = String.raw`\\server\share\resultat.json`
    for (const path of ['/tmp/resultat.json', '~/Documents/resultat.json', 'C:\\QA\\resultat.json', share]) {
      expect(resolveDocumentFilePath(path, '/qa/rapport.md')).toBe(path)
    }
    expect(resolveDocumentFilePath('resultat.json', 'C:\\QA\\rapport.md')).toBe('C:/QA/resultat.json')
    expect(resolveDocumentFilePath('resultat.json', 'C:\\rapport.md')).toBe('C:/resultat.json')
    expect(resolveDocumentFilePath('resultat.json', String.raw`\\server\share\rapport.md`))
      .toBe('//server/share/resultat.json')
  })
})
