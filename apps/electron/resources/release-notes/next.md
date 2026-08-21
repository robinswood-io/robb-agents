# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- Make Remote a responsive, accessible PWA across phones and tablets, with a privacy-preserving offline shell, immediate reconnect states, and user-controlled app updates.
- Support validated public HTTPS/WSS endpoints for Remote reverse proxies so pairing links and browser sessions stay on the trusted public origin.
- Let Task and Mission sub-agents inherit full Execute autonomy, including shell, browser, MCP, and network tools, only when their parent is in Execute and the workspace explicitly enables external actions in Execute; all other cases remain fail-closed.
- Add a workspace-level “Full autonomy in Execute” policy that removes redundant sensitive-action confirmations for scoped work and grants required secure-site browser permissions only while an Execute agent is actively in control.
- Preload active source guides into the agent context with credential-shaped values redacted, avoiding the first-call guide rejection while preserving strict browser and skill prerequisites.
- Retry the original request automatically after a required source is activated instead of asking the user to send it again.
- Expire invisible permission requests, replay still-live prompts after a renderer reload, and remember approved sensitive actions only for the same category and concrete target.
- Make production packaging fail closed on dirty or unverifiable source provenance and require a strict Developer ID signature, notarization, and stapled ticket.

## Bug Fixes

- Keep Remote pairing usable in short landscape and under the mobile keyboard, prevent focus from entering off-screen panels, and avoid TopBar collisions with Remote controls.
- Fix Remote openings that returned `Internal Server Error` after pairing or cookie loss by emitting Node-compatible same-origin login redirects.
- Record sanitized Remote HTTP failure metadata without retaining URLs, queries, cookies, headers, request bodies, or exception messages.
- Resume Codex/Pi turns that stop after a tool result or an unexpectedly aborted partial response, and durably continue interrupted turns after a provider failure or application restart with bounded retries.
- Execute the integrated-browser fallback after a compatible tool failure instead of merely logging the intended recovery.
- Redact OAuth callback codes, state, identity, verifier, and session artifacts before browser-console retention or file logging.
- Harden local logs to owner-only access and scrub sensitive OAuth artifacts left by older builds on the next application start.

## Breaking Changes
