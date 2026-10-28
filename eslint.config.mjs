import { defineConfig } from 'eslint/config';
import parser from '@typescript-eslint/parser';
import plugin from '@typescript-eslint/eslint-plugin';
import electron from './apps/electron/eslint.rules.mjs';
import shared from './packages/shared/eslint.rules.mjs';
import server from './packages/server-core/eslint.rules.mjs';
import ui from './packages/ui/eslint.rules.mjs';

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
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true },
      projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true, 'ts-check': false,
      }],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: { 'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }] },
  },
]);
