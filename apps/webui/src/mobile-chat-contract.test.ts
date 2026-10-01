import { describe, expect, it } from 'bun:test'

describe('PWA mobile chat viewport contract', () => {
  it('requests keyboard-aware resizing without disabling accessible zoom', async () => {
    const html = await Bun.file(new URL('./index.html', import.meta.url)).text()
    expect(html).toContain('interactive-widget=resizes-content')
    expect(html).not.toContain('user-scalable=no')
    expect(html).not.toContain('maximum-scale=1')
  })

  it('keeps the focused chat editor at the iOS non-zoom font size', async () => {
    const css = await Bun.file(new URL('./index.css', import.meta.url)).text()
    expect(css).toContain("[data-tutorial='chat-input'][contenteditable='true']")
    expect(css).toMatch(/data-tutorial='chat-input'[\s\S]*font-size:\s*16px/)
  })
})
