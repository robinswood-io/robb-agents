/** Fixed, read-only canvas inspection. Executed in an isolated world, never in page script globals. */
export const CANVAS_CAPTURE_LIMITS = { dimension: 8192, pixels: 8_000_000, pngBytes: 4 * 1024 * 1024, ancestors: 64 } as const

interface Rect { x: number; y: number; width: number; height: number }
export interface CanvasBitmapReceipt {
  dataUrl: string
  width: number
  height: number
  sourceRect: Rect
  region: Rect
  canvasBox: Rect
  viewport: { width: number; height: number; dpr: number; scrollX: number; scrollY: number }
  capturedAt: number
}

// Keep this function self-contained: its source runs in the browser's isolated world.
function readCanvasBitmap(selector: string, limits: typeof CANVAS_CAPTURE_LIMITS): CanvasBitmapReceipt {
  const fail = (reason: string): never => { throw new Error(`Canvas capture unavailable: ${reason}`) }
  const candidates = document.querySelectorAll(selector)
  if (candidates.length !== 1) fail('selector must match exactly one canvas')
  const canvas = candidates[0]
  if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) return fail('target is not a connected canvas')
  const width = canvas.width, height = canvas.height
  if (!width || !height || width > limits.dimension || height > limits.dimension || width * height > limits.pixels) fail('pixel limit')
  const box = canvas.getBoundingClientRect()
  if (![box.x, box.y, box.width, box.height, innerWidth, innerHeight].every(Number.isFinite) || box.width <= 0 || box.height <= 0) fail('empty geometry')
  let left = Math.max(0, box.left), top = Math.max(0, box.top)
  let right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom)
  const documentRoot = document.documentElement
  const rootStyle = getComputedStyle(documentRoot)
  const firstBody = Array.from(documentRoot.children).find(child => child instanceof HTMLBodyElement && getComputedStyle(child).display !== 'none')
  const bodyStyle = firstBody ? getComputedStyle(firstBody) : undefined
  // https://www.w3.org/TR/css-overflow-3/#overflow-propagation
  // This element's overflow is applied to the viewport,
  // already intersected above, and its own used overflow becomes visible.
  // In particular, an out-of-flow desktop can leave BODY with a zero-height box.
  // Containment disables BODY propagation; retain ordinary clipping in that case.
  const bodyOverflowPropagates = documentRoot instanceof HTMLHtmlElement && rootStyle.display !== 'none'
    && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
    && rootStyle.contain === 'none' && bodyStyle?.contain === 'none'
    && rootStyle.containerType === 'normal' && bodyStyle?.containerType === 'normal'
    && rootStyle.contentVisibility === 'visible' && bodyStyle?.contentVisibility === 'visible'
  const viewportOverflowElement = bodyOverflowPropagates ? firstBody : documentRoot instanceof HTMLHtmlElement ? documentRoot : undefined
  let element: Element | null = canvas
  let depth = 0
  while (element) {
    if (++depth > limits.ancestors) fail('ancestor limit')
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1 || style.contentVisibility === 'hidden') fail('hidden or translucent target')
    if (style.filter !== 'none' || style.backdropFilter !== 'none' || style.clipPath !== 'none' || style.maskImage !== 'none' || style.clip !== 'auto' || style.mixBlendMode !== 'normal' || style.perspective !== 'none') fail('unsupported visual effect or clipping')
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform)
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) fail('unsupported transform')
    }
    // Individual transform properties are independent of the transform matrix.
    if (style.rotate !== 'none' || style.scale !== 'none' || style.translate !== 'none') fail('unsupported individual transform')
    if (element === canvas && (style.objectFit !== 'fill' || [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(v => parseFloat(v) !== 0))) fail('unsupported canvas box')
    const clipsX = element !== viewportOverflowElement && /^(hidden|clip|scroll|auto)$/.test(style.overflowX)
    const clipsY = element !== viewportOverflowElement && /^(hidden|clip|scroll|auto)$/.test(style.overflowY)
    const paintContainment = /(?:paint|strict|content)/.test(style.contain)
    if (clipsX || clipsY || paintContainment) {
      if ([style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some(v => parseFloat(v) !== 0)) fail('rounded clipping is unsupported')
      if (!(element instanceof HTMLElement)) return fail('non-HTML clipping is unsupported')
      const rect = element.getBoundingClientRect()
      if (!element.offsetWidth || !element.offsetHeight) fail('empty clipping geometry')
      const sx = rect.width / element.offsetWidth, sy = rect.height / element.offsetHeight
      const x = rect.left + element.clientLeft * sx, y = rect.top + element.clientTop * sy
      if (clipsX || paintContainment) { left = Math.max(left, x); right = Math.min(right, x + element.clientWidth * sx) }
      if (clipsY || paintContainment) { top = Math.max(top, y); bottom = Math.min(bottom, y + element.clientHeight * sy) }
    }
    element = element.parentElement
  }
  if (right <= left || bottom <= top) fail('outside visible rectangle')
  const sx = box.width / width, sy = box.height / height
  // Crop inwards: never include pixels outside the visible rectangular intersection.
  const x = Math.max(0, Math.ceil((left - box.left) / sx)), y = Math.max(0, Math.ceil((top - box.top) / sy))
  const x2 = Math.min(width, Math.floor((right - box.left) / sx)), y2 = Math.min(height, Math.floor((bottom - box.top) / sy))
  if (x2 <= x || y2 <= y) fail('empty pixel crop')
  let dataUrl: string
  try { dataUrl = HTMLCanvasElement.prototype.toDataURL.call(canvas, 'image/png') }
  catch { return fail('bitmap cannot be read (for example an origin-tainted canvas); permissions were not changed') }
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 22 + Math.ceil(limits.pngBytes / 3) * 4) fail('encoded image limit or unavailable bitmap')
  return { dataUrl, width, height, sourceRect: { x, y, width: x2 - x, height: y2 - y },
    region: { x: box.left + x * sx, y: box.top + y * sy, width: (x2 - x) * sx, height: (y2 - y) * sy },
    canvasBox: { x: box.x, y: box.y, width: box.width, height: box.height },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY }, capturedAt: Date.now() }
}

export function buildCanvasCaptureExpression(selector: string): string {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 1024) throw new Error('Canvas capture requires a bounded CSS selector')
  return `(${readCanvasBitmap.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(CANVAS_CAPTURE_LIMITS)})`
}

export function validateCanvasBitmapReceipt(value: unknown): { receipt: CanvasBitmapReceipt; png: Buffer } {
  const bad = (): never => { throw new Error('Canvas capture returned an invalid, empty or oversized bitmap receipt') }
  const r = value as CanvasBitmapReceipt | null
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const rect = (v: Rect | undefined) => v && [v.x, v.y, v.width, v.height].every(finite) && v.width > 0 && v.height > 0
  if (!r || !Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width <= 0 || r.height <= 0 || r.width > CANVAS_CAPTURE_LIMITS.dimension || r.height > CANVAS_CAPTURE_LIMITS.dimension || r.width * r.height > CANVAS_CAPTURE_LIMITS.pixels || !rect(r.sourceRect) || !rect(r.region) || !rect(r.canvasBox) || !r.viewport || ![r.viewport.width, r.viewport.height, r.viewport.dpr, r.viewport.scrollX, r.viewport.scrollY, r.capturedAt].every(finite)) return bad()
  const crop = r.sourceRect
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.x + crop.width > r.width || crop.y + crop.height > r.height || r.viewport.width <= 0 || r.viewport.height <= 0 || r.viewport.dpr <= 0) return bad()
  if (typeof r.dataUrl !== 'string' || r.dataUrl.length > 22 + Math.ceil(CANVAS_CAPTURE_LIMITS.pngBytes / 3) * 4 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(r.dataUrl)) return bad()
  const png = Buffer.from(r.dataUrl.slice(22), 'base64')
  // Check the PNG's own dimensions before allowing native decoding/allocation.
  if (png.length < 33 || png.length > CANVAS_CAPTURE_LIMITS.pngBytes || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString() !== 'IHDR' || png.readUInt32BE(16) !== r.width || png.readUInt32BE(20) !== r.height) return bad()
  const copyRect = (v: Rect): Rect => ({ x: v.x, y: v.y, width: v.width, height: v.height })
  return { receipt: { dataUrl: r.dataUrl, width: r.width, height: r.height, sourceRect: copyRect(r.sourceRect),
    region: copyRect(r.region), canvasBox: copyRect(r.canvasBox), capturedAt: r.capturedAt,
    viewport: { width: r.viewport.width, height: r.viewport.height, dpr: r.viewport.dpr, scrollX: r.viewport.scrollX, scrollY: r.viewport.scrollY } }, png }
}
