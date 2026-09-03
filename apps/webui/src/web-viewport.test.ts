import { describe, expect, it } from 'bun:test'
import { readUsableViewportHeight } from './web-viewport'

function viewport(innerHeight: number, visualHeight?: number, scale = 1) {
  return {
    innerHeight,
    visualViewport: visualHeight == null ? null : {
      height: visualHeight,
      scale,
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
  }
}

describe('PWA usable viewport height', () => {
  it('uses the visual viewport when the virtual keyboard reduces it', () => {
    expect(readUsableViewportHeight(viewport(844, 477))).toBe(477)
  })

  it('keeps the layout viewport during user pinch zoom', () => {
    expect(readUsableViewportHeight(viewport(844, 422, 2))).toBe(844)
  })

  it('falls back safely when VisualViewport is unavailable or oversized', () => {
    expect(readUsableViewportHeight(viewport(720))).toBe(720)
    expect(readUsableViewportHeight(viewport(720, 740))).toBe(720)
    expect(readUsableViewportHeight(viewport(720, 0))).toBe(720)
    expect(readUsableViewportHeight(viewport(720, Number.NaN))).toBe(720)
  })
})
