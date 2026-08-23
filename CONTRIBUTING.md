# Contributing to Robb Agents

Thank you for contributing to **Robb Agents**, an MIT-licensed, French-first open-source distribution maintained by Robinswood.

## Start here

```bash
git clone https://github.com/robinswood-io/robb-agents.git
cd robinswood-agents
bun install --frozen-lockfile
bun run electron:dev
```

Prerequisites: Bun 1.3.9+, Node.js 20+, and platform tooling appropriate to the component you are changing.

## Development, local staging, and release promotion

Robb Agents uses three separate targets. Select the target explicitly before
building or installing anything:

| Target | Application/profile | Purpose |
|---|---|---|
| Development | Robb Agents Dev / `~/.craft-agent-dev` | Daily development and isolated testing |
| Local staging | `/Applications/Robb Agents.app` / `~/.craft-agent` | Validate a candidate with the existing production chats, credentials, browser state, and MCP configuration |
| GitHub Release | Signed public artifacts | Distribute only after local staging acceptance and all release gates pass |

Use `bun run electron:dev` for normal development. Never install a
development-channel artifact over `/Applications/Robb Agents.app`.

To update the local production application as a staging candidate, start from
a clean, identifiable commit and run:

```bash
bash apps/electron/scripts/build-dmg.sh arm64 --local-production
```

Back up the installed bundle before replacement, then verify the embedded
commit, the `~/.craft-agent/robb-electron` runtime path, historical sessions,
configured connections, and relevant MCP processes. This ad-hoc package must
remain local. Merging a pull request into `main` does not publish a GitHub
Release; create a release tag only after the staging result has been explicitly
accepted.

## Pull requests

1. Branch from `robinswood/main`.
2. Keep changes focused and avoid committing generated artifacts, `.env` files, credentials, certificates, or tokens.
3. Run relevant checks before opening a pull request:

   ```bash
   bun run typecheck:shared
   bun run typecheck:electron
   bun run typecheck:release-contract
   bun run test:release-contract
   bun run test:installer-contract
   python3 scripts/robinswood-validate.py
   ```

4. Explain the user outcome, tests run, and any platform-specific limitation in the pull request.

## Distribution changes

Installer changes must preserve these OSS rules:

- no private updater, proxy, analytics, bucket, or password-manager dependency;
- release signing credentials remain external CI/operator secrets;
- release tags fail closed until required signing/notarization secrets are available; unsigned builds stay private CI test artifacts;
- release artifacts ship checksums, provenance evidence, verified installer helpers, and actual macOS/Windows package journey validation;
- manifest, installer and complete-bundle contracts pass on macOS, Windows and Linux CI;
- do not claim signed/notarized distribution unless the release verification has passed.

Read [the distribution guide](docs/robinswood/open-source-distribution.md) before changing macOS, Windows, or GitHub Release workflows.

## Code conventions

- TypeScript is the primary implementation language.
- Follow existing local patterns and add focused tests for behavior changes.
- Preserve the `@craft-agent/*` internal package names and `craftagents://` deep link for upstream mergeability.
- Keep provider and routing behavior policy-first and fail-closed.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). Upstream Craft Agents attribution remains in [NOTICE](NOTICE) and [LICENSE-APACHE](LICENSE-APACHE).
