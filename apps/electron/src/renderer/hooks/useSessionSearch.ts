/** Separate pure session filters, date grouping and collapsed pagination from the React search hook. */
export type { FilterMode, DateGroup, ContentSearchResult, CollapsedGroupMeta, UseSessionSearchOptions, UseSessionSearchResult, CollapsedPaginationResult } from './useSessionSearch/matching.ts';
export { computeCollapsedPagination, sessionMatchesCurrentFilter } from './useSessionSearch/matching.ts';
export { useSessionSearch } from './useSessionSearch/search-hook.ts';
