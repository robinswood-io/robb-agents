import { describe, expect, test } from 'bun:test'
import { openSafeExternalUrl } from '../safe-external-url'

describe('openSafeExternalUrl', () => {
  test('opens a public HTTPS URL', async () => {
    const openedUrls: string[] = []

    await openSafeExternalUrl('https://example.com/docs', async (url) => {
      openedUrls.push(url)
    })

    expect(openedUrls).toEqual(['https://example.com/docs'])
  })

  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'craftagents://internal/settings',
    'vscode://file/etc/passwd',
    'https://user:password@example.com',
  ])('rejects unsafe URL %s', async (url) => {
    let opened = false

    await expect(
      openSafeExternalUrl(url, async () => {
        opened = true
      }),
    ).rejects.toThrow('Refusing to open an unsafe external URL')

    expect(opened).toBe(false)
  })
})
