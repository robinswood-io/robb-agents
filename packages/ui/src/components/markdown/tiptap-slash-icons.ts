export type SlashIconName =
  | 'pilcrow'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'list'
  | 'list-ordered'
  | 'list-checks'
  | 'quote'
  | 'text-quote'
  | 'minus'
  | 'code-xml'
  | 'square-code'
  | 'workflow'
  | 'sigma'


export const LUCIDE_ICON_NODES: Record<SlashIconName, Array<[string, Record<string, string>]>> = {
  pilcrow: [
    ['path', { d: 'M13 4v16' }],
    ['path', { d: 'M17 4v16' }],
    ['path', { d: 'M19 4H9.5a4.5 4.5 0 0 0 0 9H13' }],
  ],
  'heading-1': [
    ['path', { d: 'M4 12h8' }],
    ['path', { d: 'M4 18V6' }],
    ['path', { d: 'M12 18V6' }],
    ['path', { d: 'm17 12 3-2v8' }],
  ],
  'heading-2': [
    ['path', { d: 'M4 12h8' }],
    ['path', { d: 'M4 18V6' }],
    ['path', { d: 'M12 18V6' }],
    ['path', { d: 'M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1' }],
  ],
  'heading-3': [
    ['path', { d: 'M4 12h8' }],
    ['path', { d: 'M4 18V6' }],
    ['path', { d: 'M12 18V6' }],
    ['path', { d: 'M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2' }],
    ['path', { d: 'M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2' }],
  ],
  list: [
    ['path', { d: 'M3 5h.01' }],
    ['path', { d: 'M3 12h.01' }],
    ['path', { d: 'M3 19h.01' }],
    ['path', { d: 'M8 5h13' }],
    ['path', { d: 'M8 12h13' }],
    ['path', { d: 'M8 19h13' }],
  ],
  'list-ordered': [
    ['path', { d: 'M11 5h10' }],
    ['path', { d: 'M11 12h10' }],
    ['path', { d: 'M11 19h10' }],
    ['path', { d: 'M4 4h1v5' }],
    ['path', { d: 'M4 9h2' }],
    ['path', { d: 'M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02' }],
  ],
  'list-checks': [
    ['path', { d: 'm3 17 2 2 4-4' }],
    ['path', { d: 'm3 7 2 2 4-4' }],
    ['path', { d: 'M13 6h8' }],
    ['path', { d: 'M13 12h8' }],
    ['path', { d: 'M13 18h8' }],
  ],
  quote: [
    ['path', { d: 'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z' }],
    ['path', { d: 'M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z' }],
  ],
  'text-quote': [
    ['path', { d: 'M17 5H3' }],
    ['path', { d: 'M21 12H8' }],
    ['path', { d: 'M21 19H8' }],
    ['path', { d: 'M3 12v7' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  'code-xml': [
    ['path', { d: 'm18 16 4-4-4-4' }],
    ['path', { d: 'm6 8-4 4 4 4' }],
    ['path', { d: 'm14.5 4-5 16' }],
  ],
  'square-code': [
    ['path', { d: 'm10 9-3 3 3 3' }],
    ['path', { d: 'm14 15 3-3-3-3' }],
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
  ],
  workflow: [
    ['rect', { width: '8', height: '8', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M7 11v4a2 2 0 0 0 2 2h4' }],
    ['rect', { width: '8', height: '8', x: '13', y: '13', rx: '2' }],
  ],
  sigma: [
    ['path', { d: 'M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2' }],
  ],
}


export function createLucideIcon(name: SlashIconName): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (const [tag, attrs] of LUCIDE_ICON_NODES[name]) {
    const child = document.createElementNS(svgNs, tag)
    for (const [key, value] of Object.entries(attrs)) {
      child.setAttribute(key, value)
    }
    svg.appendChild(child)
  }

  return svg
}
