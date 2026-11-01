import { test, expect } from 'bun:test'
import { Linter } from 'eslint'
import rule from './no-direct-file-open.ts'
function lint(code: string) {
  return new Linter({ cwd: '/repo' }).verify(code, [{
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { links: { rules: { guard: rule } } },
    rules: { 'links/guard': 'error' },
  }], { filename: '/repo/SessionFilesSection.tsx' })
}
for (const code of [
  "if (file.type === 'directory') { window.electronAPI.openFile(file.path) }",
  'onOpenFile(file.path)',
]) {
  test('accepts intercepted files or an exact directory-only effect: ' + code, () => {
    expect(lint(code)).toHaveLength(0)
  })
}
for (const code of [
  'window.electronAPI.openFile(file.path)',
  "if (file.type === 'file') { window.electronAPI.openFile(file.path) }",
  "if (file.type === 'directory') {} else { window.electronAPI.openFile(file.path) }",
  "if (file.type === 'directory') { window.electronAPI.openFile(other.path) }",
  "if (file.type === 'directory') { file.path = other.path; window.electronAPI.openFile(file.path) }",
]) {
  test('keeps file previews mandatory: ' + code, () => {
    const messages = lint(code)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe('links/guard')
  })
}
