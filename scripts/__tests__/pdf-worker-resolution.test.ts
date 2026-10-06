import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { resolveReactPdfWorker } from '../pdf-worker-resolution'

describe('shared browser PDF worker', () => {
  it('uses the same PDF.js installation and version as the react-pdf renderer API', () => {
    const require = createRequire(import.meta.url)
    const reactPdfRequire = createRequire(require.resolve('react-pdf'))
    const apiPath = reactPdfRequire.resolve('pdfjs-dist')
    const workerPath = resolveReactPdfWorker()
    expect(dirname(workerPath)).toBe(dirname(apiPath))
    const version = JSON.parse(readFileSync(join(dirname(apiPath), '../package.json'), 'utf8')).version
    expect(readFileSync(workerPath, 'utf8')).toContain(version)
    expect(JSON.parse(readFileSync(reactPdfRequire.resolve('react-pdf/package.json'), 'utf8'))
      .dependencies['pdfjs-dist']).toBe(version)
  })
})
