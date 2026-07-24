import { isSafeExternalUrl } from '@craft-agent/shared/utils/url-safety'

const PRELOAD_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export async function openSafeExternalUrl(
  url: string,
  openExternal: (safeUrl: string) => Promise<void>,
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Refusing to open an unsafe external URL')
  }

  if (
    !isSafeExternalUrl(url)
    || !PRELOAD_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase())
    || parsed.username
    || parsed.password
  ) {
    throw new Error('Refusing to open an unsafe external URL')
  }

  await openExternal(url)
}
