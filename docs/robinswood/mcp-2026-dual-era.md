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

Server-side registration of application Tasks remains disabled until Robb owns
its durable backend, authorization, cancellation and lifecycle contract.
The former SDK 2.0.0 dispatch collision (#2598) is no longer reproduced with
`@modelcontextprotocol/server@2.4.0`: the positive regression test
`packages/session-mcp-server/src/mcp-tasks-sdk-compat.test.ts` reaches custom
2026 `tasks/get`, `tasks/cancel` and `tasks/update` handlers, while retaining
the 2025 core methods. No raw transport interception is needed. The local
projection and external wire conformance runner remain available.

## Legacy SSE policy

New or reconfigured legacy SSE source transports are rejected. Existing SSE
configs remain readable for inspection and migration, and bookkeeping-only
writes may preserve their unchanged MCP connection block. No new SSE runtime
path is introduced. They can always migrate to Streamable HTTP or stdio. The
same policy is applied to storage writes, agent-authored config writes, and
resource-bundle imports.

The obsolete API bridge bundle has been removed. The maintained Claude and Pi
backends use their native source/server APIs; no backend reads the old bridge
runtime path or implements its former update hook. Source activation keeps its
revocation checks, rollback and quarantine around the actual server update.
Builds remove stale copies of the retired bundle from staged Electron resources.

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
