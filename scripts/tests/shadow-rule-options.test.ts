import { expect, test } from 'bun:test'
import { Linter, type Rule } from 'eslint'
import electronRule from '../../apps/electron/eslint-rules/no-nonstandard-shadows.ts'
import uiRule from '../../packages/ui/eslint-rules/no-nonstandard-shadows.ts'

interface Options {
  allowInlineNone?: boolean
  allowedClasses?: string[]
}

function lint(rule: Rule.RuleModule, code: string, options: Options) {
  return new Linter().verify(code, [{
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { shadows: { rules: { guard: rule } } },
    rules: { 'shadows/guard': ['error', options] },
  }])
}

for (const [name, rule] of [['electron', electronRule], ['ui', uiRule]] as const) {
  test(`${name}: preserves default, enabled and disabled inline-none policy`, () => {
    const code = "element.style.boxShadow = 'none'"
    expect(lint(rule, code, {})).toEqual([])
    expect(lint(rule, code, { allowInlineNone: true })).toEqual([])
    expect(lint(rule, code, { allowInlineNone: false })[0]?.ruleId).toBe('shadows/guard')
    expect(lint(rule, "element.style.boxShadow = '0 0 4px black'", {})[0]?.ruleId).toBe('shadows/guard')
  })

  test(`${name}: honors explicit class list, including an empty list`, () => {
    const code = 'const view = <div className="shadow-none" />'
    expect(lint(rule, code, {})).toEqual([])
    expect(lint(rule, code, { allowedClasses: ['shadow-none'] })).toEqual([])
    expect(lint(rule, code, { allowedClasses: [] })[0]?.ruleId).toBe('shadows/guard')
  })
}
