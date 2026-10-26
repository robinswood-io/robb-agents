const { test, expect } = require('bun:test')
const { Linter } = require('eslint')
const rule = require('./no-localstorage.cjs')

const owner = '/repo/apps/electron/src/renderer/lib/local-storage.ts'
const caller = '/repo/apps/electron/src/renderer/lib/other-cache.js'
function lint(code, filename = caller) {
  return new Linter({ cwd: '/repo' }).verify(code, [{
    files: ['**/*.{js,ts}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { storage: { rules: { guard: rule } } },
    rules: { 'storage/guard': 'error' },
  }], { filename })
}

for (const code of [
  "localStorage.getItem('qa')",
  "localStorage.setItem('qa', 'value')",
  "localStorage.removeItem('qa')",
  'consume(localStorage)',
  'const cache = localStorage',
  'consume({ localStorage })',
  "window.localStorage.getItem('qa')",
  'const cache = window.localStorage',
  "window['localStorage'].getItem('qa')",
  "globalThis.localStorage.getItem('qa')",
  "self.localStorage.getItem('qa')",
]) {
  test(`rejects raw browser storage once: ${code}`, () => {
    const messages = lint(code)
    expect(messages).toHaveLength(1)
    expect(messages[0].ruleId).toBe('storage/guard')
  })
}

for (const code of [
  'function fixture(localStorage) { return { localStorage } }',
  "const object = { localStorage: 'fixture' }",
  "function fixture(window) { return window.localStorage.getItem('qa') }",
  "function fixture(globalThis) { return globalThis.localStorage }",
  "const localStorage = { getItem() {} }; localStorage.getItem('qa')",
  "import { localStorage } from 'fixture'; consume(localStorage)",
  "const object = { localStorage: 'fixture' }; consume(object.localStorage)",
  "storage.getRaw(storage.KEYS.sidebarWidth)",
]) {
  test(`accepts typed access or local fixture: ${code}`, () => {
    expect(lint(code)).toEqual([])
  })
}

test('only the existing storage owner may access the browser API', () => {
  expect(lint('window.localStorage', owner)).toEqual([])
  expect(lint('window.localStorage', owner.replace('.ts', '-other.ts'))).toHaveLength(1)
})
