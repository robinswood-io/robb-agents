import { describe, expect, test } from 'bun:test'
import { generateCallbackPage } from '../callback-page.ts'

describe('OAuth callback page security', () => {
  test('escapes untrusted titles and error details', () => {
    const html = generateCallbackPage({
      title: '</title><script>alert(1)</script>',
      isSuccess: false,
      errorDetail: '</div><img src=x onerror=alert(1)>',
    })

    expect(html).not.toContain('</title><script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;')
  })

  test('rejects non-application deep links', () => {
    const html = generateCallbackPage({
      title: 'Complete',
      isSuccess: true,
      deeplinkUrl: 'javascript:alert(1)',
    })

    expect(html).not.toContain('javascript:alert(1)')
    expect(html).not.toContain('class="return-link"')
  })

  test('serializes an approved deep link without creating executable markup', () => {
    const html = generateCallbackPage({
      title: 'Complete',
      isSuccess: true,
      deeplinkUrl: 'craftagents://oauth/callback?value=%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
    })

    expect(html).toContain('craftagents://oauth/callback')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
