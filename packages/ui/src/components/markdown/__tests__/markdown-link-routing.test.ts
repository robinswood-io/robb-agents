import { describe, it, expect } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { classifyMarkdownLinkTarget, resolveMarkdownLinkTarget } from '../link-target'
import { markdownUrlTransform } from '../url-transform'

describe('resolveMarkdownLinkTarget', () => {
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.craft-agent/sessions/abc/image.jpg',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('decodes percent-encoded bare file paths (#944)', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('normalizes windows drive-letter file URLs to local paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:/Users/Tester/Deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('routes agent sandbox-prefixed host documents to the same file reader without changing their root', () => {
    for (const target of ['sandbox:/Users/tester/session/data/rapport.pdf',
      'sandbox:///Users/tester/session/data/rapport.pdf']) {
      expect(resolveMarkdownLinkTarget(target)).toEqual({ kind: 'file', path: '/Users/tester/session/data/rapport.pdf' })
    }
    expect(resolveMarkdownLinkTarget('sandbox:/mnt/data/rapport.pdf')).toEqual({ kind: 'file', path: '/mnt/data/rapport.pdf' })
    expect(resolveMarkdownLinkTarget('sandbox:/Users/tester/Compte%20rendu%20%C3%A9t%C3%A9.pdf'))
      .toEqual({ kind: 'file', path: '/Users/tester/Compte rendu été.pdf' })
  })

  it('does not reinterpret remote sandbox authorities or other schemes as local files', () => {
    for (const target of ['sandbox://remote.example/rapport.pdf', 'sandbox:////remote/rapport.pdf',
      'sandbox:rapport.pdf', 'javascript:rapport.pdf', 'data:application/pdf;base64,AA',
      'https://example.com/rapport.pdf']) {
      expect(resolveMarkdownLinkTarget(target)).toEqual({ kind: 'url', url: target })
    }
  })

  it('accepts explicit raw HTML destinations with spaces, Unicode and relative paths', () => {
    for (const path of ['/Users/tester/Compte rendu été.pdf', 'documents/Compte rendu été.pdf',
      './Compte rendu été.pdf', '../Compte rendu été.pdf', 'Compte rendu été.pdf']) {
      expect(resolveMarkdownLinkTarget(path)).toEqual({ kind: 'file', path })
    }
  })

  it('opens relative PDFs with a standard page fragment while preserving literal hashes in filenames', () => {
    expect(resolveMarkdownLinkTarget('documents/rapport.pdf#page=2'))
      .toEqual({ kind: 'file', path: 'documents/rapport.pdf' })
    expect(resolveMarkdownLinkTarget('/tmp/rapport#2.pdf')).toEqual({ kind: 'file', path: '/tmp/rapport#2.pdf' })
    expect(resolveMarkdownLinkTarget('/tmp/rapport%23page%3D2.pdf')).toEqual({ kind: 'file', path: '/tmp/rapport#page=2.pdf' })
    const web = 'https://example.com/rapport.pdf#page=2'
    expect(resolveMarkdownLinkTarget(web)).toEqual({ kind: 'url', url: web })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('markdownUrlTransform', () => {
  it('preserves dangerous anchor hrefs for custom click routing', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('file:///tmp/test.md', 'href', anchorNode as never)).toBe('file:///tmp/test.md')
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode as never)).toBe('javascript:alert(1)')
  })

  it('still sanitizes dangerous non-anchor URL attributes', () => {
    const imageNode = { tagName: 'img' }
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imageNode as never)).toBe('')
  })

  it('keeps safe anchor hrefs unchanged', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('https://example.com', 'href', anchorNode as never)).toBe('https://example.com')
  })
})

describe('ReactMarkdown anchor rendering with markdownUrlTransform', () => {
  function render(markdown: string): string {
    return renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => React.createElement('a', {
          href: href ? defaultUrlTransform(href) || undefined : undefined,
          'data-raw-href': href,
        }, children),
      },
      children: markdown,
    }))
  }

  it('lets file links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[report](file:///Users/tester/report.pdf)')
    expect(html).toContain('data-raw-href="file:///Users/tester/report.pdf"')
    expect(html).not.toContain('<a href="file:///Users/tester/report.pdf"')
  })

  it('preserves a sandbox document target for dispatch without a navigable sandbox href', () => {
    const html = render('[Rapport](sandbox:/Users/tester/session/data/rapport.pdf)')
    expect(html).toContain('data-raw-href="sandbox:/Users/tester/session/data/rapport.pdf"')
    expect(html).not.toContain('<a href="sandbox:')
  })

  it('preserves CommonMark destinations containing spaces and accents', () => {
    const html = render('[Rapport](</Users/tester/Compte rendu été.pdf>)')
    expect(html).toContain('data-raw-href="/Users/tester/Compte%20rendu%20%C3%A9t%C3%A9.pdf"')
  })

  it('lets javascript links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[boom](javascript:alert(1))')
    expect(html).toContain('data-raw-href="javascript:alert(1)"')
    expect(html).not.toContain('<a href="javascript:alert')
  })

  it('keeps safe web links in the DOM href for normal browser affordances', () => {
    const html = render('[site](https://example.com/path)')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies bare file paths with percent-encoded spaces as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/tester/My%20Documents/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})
