import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'path'

const configDir = import.meta.dirname
const webBaselineTargets = ['chrome111', 'edge111', 'firefox114', 'safari16.4']
const webuiPackage = JSON.parse(
  readFileSync(resolve(configDir, 'package.json'), 'utf8'),
) as { version: string }

export default defineConfig({
  plugins: [
    react(),
    babel({
      plugins: [
        'jotai-babel/plugin-debug-label',
        ['jotai-babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
      ],
    }),
    tailwindcss(),
  ],
  root: resolve(configDir, 'src'),
  base: '/',
  build: {
    // Vite 8's Baseline Widely Available target set, expressed for Oxc/Rolldown.
    target: webBaselineTargets,
    outDir: resolve(configDir, 'dist'),
    emptyOutDir: true,
    // Remote bundles are public assets. Do not ship source maps containing
    // internal renderer source or cache them in the PWA shell.
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: resolve(configDir, 'src/index.html'),
        login: resolve(configDir, 'src/login.html'),
        sw: resolve(configDir, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'sw'
          ? 'sw.js'
          : 'assets/[name]-[hash].js',
      },
      // Suppress warnings for Node.js externalized modules — these are
      // referenced by shared code but only used in server/Electron codepaths.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      // Reuse the Electron renderer's components, hooks, pages, etc.
      '@': resolve(configDir, '../electron/src/renderer'),
      // Web-specific overrides
      '@webui': resolve(configDir, 'src'),
      // Config alias (same as Electron)
      '@config': resolve(configDir, '../../packages/shared/src/config'),
      // Force single React copy from root node_modules
      'react': resolve(configDir, '../../node_modules/react'),
      'react-dom': resolve(configDir, '../../node_modules/react-dom'),
      // Electron-specific modules → empty shims for browser builds
      'electron-log/renderer': resolve(configDir, 'src/shims/electron-log.ts'),
      'electron-log/main': resolve(configDir, 'src/shims/electron-log.ts'),
      'electron-log': resolve(configDir, 'src/shims/electron-log.ts'),
      '@sentry/electron/renderer': resolve(configDir, 'src/shims/sentry-electron.ts'),
      '@sentry/electron': resolve(configDir, 'src/shims/sentry-electron.ts'),
      // Node.js 'ws' library → browser uses native WebSocket
      'ws': resolve(configDir, 'src/shims/ws.ts'),
      // Node.js builtins → browser-safe shims (shared code imports these
      // but the codepaths aren't reached in browser — web API adapter intercepts)
      // Node.js builtins → browser-safe shims (shared code imports these
      // but the codepaths aren't reached in browser — web API adapter intercepts)
      ...Object.fromEntries([
        'fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process',
        'os', 'node:os', 'node:crypto', 'node:util', 'node:process', 'node:buffer',
        'node:https', 'node:http', 'node:net', 'node:url', 'node:events',
        'crypto', 'https', 'http', 'net', 'events', 'util', 'buffer', 'stream',
        'node:stream', 'tls', 'node:tls', 'url', 'zlib', 'node:zlib',
        'string_decoder', 'node:string_decoder', 'assert', 'node:assert',
      ].map(m => [m, resolve(configDir, 'src/shims/node-builtins.ts')])),
      // fs/promises and node:fs/promises need a separate shim file to avoid path confusion
      'fs/promises': resolve(configDir, 'src/shims/fs-promises.ts'),
      'node:fs/promises': resolve(configDir, 'src/shims/fs-promises.ts'),
      // 'open' npm package (Node.js shell utility) — no-op in browser
      'open': resolve(configDir, 'src/shims/open.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    // Flag to detect web UI context in shared code
    'import.meta.env.IS_WEBUI': 'true',
    // A release version change produces a new worker and cache namespace.
    'import.meta.env.PWA_CACHE_VERSION': JSON.stringify(webuiPackage.version),
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai'],
    exclude: ['@craft-agent/ui'],
    rolldownOptions: {
      transform: { target: webBaselineTargets },
    },
  },
  server: {
    port: 5175,
    open: false,
    host: true,
    // Proxy API + WS to the headless server so the dev bundle on :5175 works
    // end-to-end with HMR. Target port follows CRAFT_RPC_PORT (default 9100).
    // Auto-detects TLS: if the server has CRAFT_RPC_TLS_KEY/CERT set, we proxy
    // over https/wss with secure:false to accept the self-signed dev cert.
    proxy: (() => {
      const port = process.env.CRAFT_RPC_PORT ?? '9100'
      const useTls = Boolean(process.env.CRAFT_RPC_TLS_KEY || process.env.CRAFT_RPC_TLS_CERT)
      const httpProto = useTls ? 'https' : 'http'
      const wsProto = useTls ? 'wss' : 'ws'
      const httpTarget = `${httpProto}://127.0.0.1:${port}`
      const wsTarget = `${wsProto}://127.0.0.1:${port}`
      return {
        '/api': { target: httpTarget, changeOrigin: true, secure: false },
        '/login': { target: httpTarget, changeOrigin: true, secure: false },
        '/ws': { target: wsTarget, ws: true, secure: false },
      }
    })(),
  },
})
