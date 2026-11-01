import { isJsonObject, parseJsonObject } from '../../packages/shared/src/utils/json.ts';
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
    const version = parseJsonObject(readFileSync(join(dirname(apiPath), '../package.json'), 'utf8'))['version']
    if (typeof version !== 'string') throw new Error('PDF worker package version is missing')
    expect(readFileSync(workerPath, 'utf8')).toContain(version)
    const dependencies = parseJsonObject(readFileSync(reactPdfRequire.resolve('react-pdf/package.json'), 'utf8'))['dependencies']
    if (!isJsonObject(dependencies)) throw new Error('react-pdf dependencies are missing')
    expect(dependencies['pdfjs-dist']).toBe(version)
  })
})
