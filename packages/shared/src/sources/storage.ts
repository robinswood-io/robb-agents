/** Source persistence: configuration, guides, workspace inventory and creation. */
export { isIconUrl } from '../utils/icon.ts';
export { parseGuideMarkdown } from "./storage/source-guides.ts";
export { getSourcePath, ensureSourcesDir, loadSourceConfig, markSourceAuthenticated, saveSourceConfig } from './storage/source-config.ts';
export { loadSourceGuide, extractTagline, saveSourceGuide, findSourceIcon, downloadSourceIcon, sourceNeedsIconDownload } from './storage/source-guides.ts';
export { loadSource, loadWorkspaceSources, getEnabledSources, isSourceUsable, getSourcesBySlugs, loadAllSources } from './storage/source-inventory.ts';
export { generateSourceSlug, createSource, deleteSource, sourceExists } from './storage/source-creation.ts';
