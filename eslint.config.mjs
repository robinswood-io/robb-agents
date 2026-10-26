import { defineConfig } from 'eslint/config';
import parser from '@typescript-eslint/parser';
import plugin from '@typescript-eslint/eslint-plugin';
import electron from './apps/electron/eslint.config.mjs';
import shared from './packages/shared/eslint.config.mjs';
import server from './packages/server-core/eslint.config.mjs';
import ui from './packages/ui/eslint.config.mjs';

export default defineConfig([
  { ignores: ['**/node_modules/**', '**/dist/**', '**/release/**', '**/release-dev/**',
    '**/.worktrees/**', 'commercial/**',
    'apps/electron/resources/bridge-mcp-server/index.js',
    'apps/electron/src/main/__tests__/fixtures/guacamole-keyboard-1.5.5.js',
    'audit/robb-0.11.6-2026-08-18/report.html',
    'docs/robinswood/reports/robb-agentic-audit-2026-08-27/report.html'] },
  { basePath: 'apps/electron', extends: electron },
  { basePath: 'packages/shared', extends: shared },
  { basePath: 'packages/server-core', extends: server },
  { basePath: 'packages/ui', extends: ui },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { '@typescript-eslint': plugin },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: { 'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }] },
  },
]);
