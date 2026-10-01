# MCP 2026-07-28 dual-era compatibility

## Shipped surfaces

Robb Agents uses the official TypeScript SDK v2 split packages on the server
surfaces that it owns:

| Surface | Modern peer | Legacy peer | Negotiation |
| --- | --- | --- | --- |
| MCP pool proxy (Streamable HTTP) | 2026-07-28 | 2025-era | `server/discover` vs. `initialize`, selected per request |
| Session MCP server (stdio) | 2026-07-28 | 2025-era | `serveStdio(..., { legacy: "serve" })` |
| Persisted-source client and validators (HTTP/stdio) | 2026-07-28 | 2025-era | SDK v2 `versionNegotiation: { mode: "auto" }` |
| Craft documentation upstream client | 2026-07-28 | 2025-era | SDK v2 `versionNegotiation: { mode: "auto" }` |

The HTTP pool remains loopback-only and validates both `Host` and `Origin`.
Modern requests are stateless; legacy clients retain the SDK compatibility
flow. Local integration tests connect one modern auto-negotiating client and
one legacy initialize client to the same endpoint.

The generic persisted-source client now negotiates both eras automatically,
including modern-only stdio validation. Its subprocess keeps the restricted
environment boundary: only the operational baseline and the source's explicit
environment grant are forwarded. The in-process API-source adapter remains on
SDK v1 behind a structural pool-tool boundary because it talks only to
application-owned v1 `McpServer` instances; it does not participate in external
wire negotiation.

## Tasks extension

MCP 2026 moves Tasks out of core into the
`io.modelcontextprotocol/tasks` extension. The compatibility layer projects a
single canonical task snapshot into either:

- the 2025 task object (`ttl`, `tasks/result`, `tasks/list`); or
- the 2026 flat task result (`resultType: "task"`, `ttlMs`) and polling flow
  (`tasks/get`, `tasks/update`, `tasks/cancel`).

The modern conformance runner verifies per-request `_meta`, `Mcp-Method` and
`Mcp-Name` routing headers, required result discriminators, cache hints on
cacheable core results, inline terminal results/errors, cooperative
cancellation, and input-response acknowledgements. It never sends
`initialize`, `tasks/result`, or `tasks/list` in the modern era.

Server-side registration of the extension methods is not claimed here. With
the pinned `@modelcontextprotocol/server@2.0.0`, the SDK classifies
`tasks/get` and `tasks/cancel` as historical core methods, then rejects them
with `-32601` in a 2026 session before consulting an explicitly registered
custom handler. The new `tasks/update` name remains reachable, and the same
`tasks/get` / `tasks/cancel` handlers remain reachable on the 2025 path. This
exact asymmetry is reproduced through the public `Server` + `serveStdio` APIs
by `packages/session-mcp-server/src/mcp-tasks-sdk-gap.test.ts` and matches the
still-open [upstream issue #2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598).

Intercepting the colliding methods before the SDK transport can bypass the
gate, but it also bypasses the SDK's era and request-schema validation. Robb
Agents does not ship that interception as a production workaround: it would
need a separately reviewed raw extension router plus a durable Tasks backend,
authorization, cancellation and lifecycle ownership. Until those pieces exist
or the SDK fixes the dispatch gate, the server capability remains disabled;
the local projection and external wire conformance runner remain usable.

## Legacy SSE policy

New or reconfigured legacy SSE source transports are rejected. Existing SSE
configs remain readable for inspection and migration, and bookkeeping-only
writes may preserve their unchanged MCP connection block. No new SSE runtime
path is introduced. They can always migrate to Streamable HTTP or stdio. The
same policy is applied to storage writes, agent-authored config writes, and
resource-bundle imports.

The legacy bridge bundle under `apps/electron/resources/bridge-mcp-server/` is
a generated compatibility artifact whose source package is no longer present
in this repository. It was not hand-edited; doing so would create an
unverifiable second source of truth.

## External conformance

The default mode probes modern support and falls back conservatively:

```bash
ROBB_INTEROP_PROTOCOL=mcp-tasks \
ROBB_INTEROP_ENDPOINT=https://server.example/mcp \
ROBB_INTEROP_MCP_ERA=auto \
bun run test:interop:external
```

Pin either path in CI with `ROBB_INTEROP_MCP_ERA=modern` or `legacy`. To execute
a safe task tool, set `ROBB_INTEROP_TOOL_NAME` and optional JSON in
`ROBB_INTEROP_TOOL_ARGUMENTS`. Interactive task responses can be supplied as
JSON in `ROBB_INTEROP_TASK_INPUT_RESPONSES`.

References: [SDK v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md),
[SDK 2026 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md),
[MCP 2026 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx),
[Tasks extension](https://tasks.extensions.modelcontextprotocol.io/).
