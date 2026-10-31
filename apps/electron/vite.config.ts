import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { resolveReactPdfWorker } from '../../scripts/pdf-worker-resolution.ts'

const configDir = import.meta.dirname

// Source maps are generated locally; upload to Sentry is disabled.
export default defineConfig({
  plugins: [
    react(),
    babel({
      plugins: [
        // Jotai HMR support: caches atom instances in globalThis.jotaiAtomCache
        // so that HMR module re-execution returns stable atom references
        // instead of creating new (empty) atoms that orphan existing data.
        'jotai-babel/plugin-debug-label',
        ['jotai-babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
      ],
    }),
    tailwindcss(),
  ],
  root: resolve(configDir, 'src/renderer'),
  base: './',
  build: {
    // Electron 43 embeds Chromium 150. Keep Oxc output aligned with that runtime.
    target: 'chrome150',
    outDir: resolve(configDir, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,  // Source maps generated for debugging. Not uploaded to Sentry (see CLAUDE.md).
    rolldownOptions: {
      input: {
        main: resolve(configDir, 'src/renderer/index.html'),
        playground: resolve(configDir, 'src/renderer/playground.html'),
        'browser-toolbar': resolve(configDir, 'src/renderer/browser-toolbar.html'),
        'browser-empty-state': resolve(configDir, 'src/renderer/browser-empty-state.html'),
      }
    }
  },
  resolve: {
    alias: {
      // The hoisted pdfjs-dist may serve another dependency at a different
      // major version. Resolve this worker next to react-pdf's actual API.
      'pdfjs-dist/build/pdf.worker.min.mjs?url': `${resolveReactPdfWorker()}?url`,
      '@': resolve(configDir, 'src/renderer'),
      '@config': resolve(configDir, '../../packages/shared/src/config'),
      // Force all React imports to use the root node_modules React
      // Bun hoists deps to root. This prevents "multiple React copies" error from @craft-agent/ui
      'react': resolve(configDir, '../../node_modules/react'),
      'react-dom': resolve(configDir, '../../node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom']
  },
  optimizeDeps: {
    // Scan linked UI dependencies before navigation triggers a second prebundle.
    entries: ['*.html', '../../../../packages/ui/src/index.ts'],
    include: ['react', 'react-dom', 'jotai', 'pdfjs-dist'],
    exclude: ['@craft-agent/ui', 'pdfjs-dist/build/pdf.worker.min.mjs?url'],
    rolldownOptions: {
      transform: { target: 'chrome150' },
    },
  },
  server: {
    port: 5173,
    open: false
  }
})
