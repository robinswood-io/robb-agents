/** Separate cache state, entity icon loading, SVG handling and the React hook. */
export type { UseEntityIconOptions } from './icon-cache/contracts.ts';
export { iconCache, logoUrlCache, sourceIconCache, skillIconCache, clearIconCaches, clearSourceIconCaches, clearSkillIconCaches } from './icon-cache/cache.ts';
export { EMOJI_ICON_PREFIX, loadSourceIcon, getSourceIconSync, loadSkillIcon, getSkillIconSync, useEntityIcon } from './icon-cache/entity-icons.ts';
export { getForegroundColor, themeSvgContent, svgToThemedDataUrl, sanitizeSvgForInline } from './icon-cache/svg.ts';
