/** Use Node/Electron's native fetch with its native AbortSignal implementation. */
export default globalThis.fetch.bind(globalThis)
export const Headers = globalThis.Headers
export const Request = globalThis.Request
export const Response = globalThis.Response
