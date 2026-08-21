# Runtime and toolchain baseline (August 2026)

## Supported baseline

Robb Agents now targets the following stable, supported line:

| Component | Project version | Rationale |
| --- | --- | --- |
| Node.js | 24 LTS (`.node-version`: `24.19.0`) | Node 20 is end-of-life; Node 24 is an active LTS line. |
| Electron | 43.4.x | Electron 43 embeds Node 24 and Chromium 150 and remains in its supported window. |
| Vite | 8.2.x | Vite 8 is the stable Rolldown/Oxc release. |
| TypeScript CLI | 7.0.x native compiler | TypeScript 7 is stable and is used for repository typechecks. |
| TypeScript API | 6.0.x | TypeScript 7 does not expose the stable JavaScript API required by `typescript-eslint`; TypeScript 6 remains installed explicitly for API consumers. |

The version choices were checked against the primary release sources: [Node.js releases](https://nodejs.org/en/about/previous-releases), [Vite 8 announcement](https://vite.dev/blog/announcing-vite8), [Vite migration guide](https://vite.dev/guide/migration), [TypeScript 6 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/), [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), and [Electron 43 announcement](https://www.electronjs.org/blog/electron-43-0).

## Migration contract

- `scripts/run-typescript.mjs native ...` invokes TypeScript 7 without relying on an ambiguous workspace `.bin/tsc` symlink.
- `scripts/run-typescript.mjs compat ...` invokes TypeScript 6 for compatibility checks and programmatic tooling.
- Every package typecheck script selects the native compiler explicitly.
- Deprecated `baseUrl` settings are removed. Workspace aliases use explicit relative targets, with `rootDir` and `types` declared per compilation boundary.
- Vite configs use `build.rolldownOptions` and `optimizeDeps.rolldownOptions`; targets are expressed for Oxc. Electron renderer output targets Chromium 150, while browser builds use Vite's widely available baseline.
- React uses the Vite 8-compatible `@vitejs/plugin-react` 6 line. Jotai's Babel transforms run through `@rolldown/plugin-babel` and the non-deprecated `jotai-babel` package.

## Validation and upgrade rules

Run these checks after dependency or compiler-option changes:

```sh
bun install --frozen-lockfile
bun run typecheck:all
node scripts/run-typescript.mjs compat --noEmit -p apps/electron/tsconfig.json
bun run electron:build
bun run viewer:build
```

Do not remove the TypeScript 6 compatibility installation until every programmatic consumer, including `typescript-eslint`, officially supports the TypeScript 7 API model. Do not replace `@vitejs/plugin-react` with `@vitejs/plugin-react-oxc` while that package's published peer range excludes Vite 8.

The TypeScript 6 API lane is pinned to `~6.0.3` under the canonical `typescript` package name. Microsoft's preferred `@typescript/typescript6` compatibility package could not be retained because Bun 1.3.14 resolves its internal `@typescript/old` alias cyclically in this workspace. Re-evaluate that package after the Bun resolver is upgraded; the current layout still gives `typescript-eslint` the supported TypeScript 6 API and keeps the TypeScript 7 CLI separately addressable.

Large-chunk and Electron renderer externalization warnings remain advisory build-budget work; they are not migration failures. The Vite 8 builds are required to complete successfully.
