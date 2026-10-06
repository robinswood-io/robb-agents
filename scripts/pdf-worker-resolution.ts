import { createRequire } from 'node:module'

/** All browser builds must load the worker from the renderer API's react-pdf dependency. */
export function resolveReactPdfWorker(): string {
  const require = createRequire(import.meta.url)
  const reactPdfRequire = createRequire(require.resolve('react-pdf'))
  return reactPdfRequire.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
}
