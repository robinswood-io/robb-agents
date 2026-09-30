import * as React from 'react'
import { Markdown, PDFPreviewOverlay, PlatformProvider } from '@craft-agent/ui'
import { useLinkInterceptor } from '@/hooks/useLinkInterceptor'
import { resolveSessionFilePath } from '@/lib/resolve-session-file-path'
import samplePdfUrl from '@/assets/samples/sample-invoice.pdf?url'

const ROOT = '/tmp/robb-pdf-preview'
const DOCUMENT = `${ROOT}/data/Compte rendu été.pdf`
const ENCODED = encodeURI(DOCUMENT)

/** Existing PDF renderer and click interceptor with fabricated paths and a real bundled PDF. */
export function LocalPdfPreviewDemo() {
  const [lastRead, setLastRead] = React.useState('')
  const [externalTarget, setExternalTarget] = React.useState('')
  const readBinary = React.useCallback(async (path: string) => {
    setLastRead(path)
    if (path !== DOCUMENT) throw new Error(`ENOENT: fichier introuvable, ${path}`)
    const response = await fetch(samplePdfUrl)
    if (!response.ok) throw new Error(`Sample PDF unavailable (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }, [])
  const interceptor = useLinkInterceptor({
    openFileExternal: async path => { setExternalTarget(path) },
    openUrl: async url => { setExternalTarget(url) },
    showInFolder: async () => {},
    readFile: async () => '', readFileDataUrl: async () => '', readFileBinary: readBinary,
  })
  const openFile = (path: string) => interceptor.handleOpenFile(resolveSessionFilePath(path, ROOT))
  const markdown = [
    `[PDF sandbox](sandbox:${ENCODED})`,
    `[PDF file URL](file://${ENCODED})`,
    `[PDF absolu](<${DOCUMENT}>)`,
    '[PDF relatif](<data/Compte rendu été.pdf>)',
    '[PDF avec fragment](<data/Compte rendu été.pdf#page=2>)',
    `<a href="${DOCUMENT}">PDF HTML</a>`,
    `[PDF introuvable](sandbox:${ROOT}/missing.pdf)`,
    '```pdf-preview', JSON.stringify({ src: `sandbox:${ENCODED}`, title: 'Aperçu du document local' }), '```',
  ].join('\n\n')
  return <PlatformProvider actions={{ onReadFileBinary: readBinary, onOpenFile: openFile,
    onOpenFileExternal: interceptor.openFileExternal }}>
    <div className="max-w-3xl p-6 space-y-3" data-testid="local-pdf-demo" data-last-read={lastRead} data-external-target={externalTarget}>
      <p className="text-sm text-muted-foreground">Données fictives · PDF de démonstration · aucune ouverture externe</p>
      <Markdown onFileClick={openFile} onUrlClick={interceptor.handleOpenUrl}>{markdown}</Markdown>
    </div>
    {interceptor.previewState?.type === 'pdf' && <PDFPreviewOverlay isOpen
      onClose={interceptor.closePreview} filePath={interceptor.previewState.filePath}
      loadPdfData={interceptor.readFileBinary} />}
  </PlatformProvider>
}
