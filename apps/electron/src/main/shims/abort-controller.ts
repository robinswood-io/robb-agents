/** Native globals keep the fetch and AbortSignal realms identical in the bundle. */
export const AbortController = globalThis.AbortController
export const AbortSignal = globalThis.AbortSignal
export default { AbortController, AbortSignal }
