/** Typed URL validation, pinned sockets, response handling, PDF text, HTML and tool factory. */
export { createPinnedDnsLookup, fetchWithPinnedDns } from './web-fetch/socket-fetch.ts';
export { createWebFetchTool } from './web-fetch/factory.ts';
export type { DnsLookupFn, ValidatedUrlTarget } from './web-fetch/network-safety.ts';
export { isPrivateIp, validateUrl } from './web-fetch/network-safety.ts';
