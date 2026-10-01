type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{
      description: string
      accept: Record<string, string[]>
    }>
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob | string) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

function safeDownloadName(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'robb-agents-export.json'
}

function downloadBlob(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = safeDownloadName(suggestedName)
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export async function saveJsonFile(
  contents: unknown,
  suggestedName: string,
): Promise<'file-system-access' | 'download' | 'aborted'> {
  const text = JSON.stringify(contents, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const picker = typeof window === 'undefined'
    ? undefined
    : (window as SaveFilePickerWindow).showSaveFilePicker

  if (typeof picker === 'function' && window.isSecureContext) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'JSON',
          accept: { 'application/json': ['.json'] },
        }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'file-system-access'
    } catch (error) {
      if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
        return 'aborted'
      }
    }
  }

  downloadBlob(blob, suggestedName)
  return 'download'
}
