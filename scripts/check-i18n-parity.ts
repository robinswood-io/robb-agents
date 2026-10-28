#!/usr/bin/env bun
/**
 * check-i18n-parity.ts — CI-safe locale parity check.
 *
 * Verifies every non-English locale has the same keys as the English locale. Plural
 * variants (`_zero` / `_one` / `_two` / `_few` / `_many` / `_other`) are
 * allowed to diverge from English because languages have different plural
 * rules (e.g. Polish needs `_few`, Japanese has no plural distinction).
 *
 * A locale file may therefore have an `X_few` key even if the English locale only has
 * `X_one` / `X_other`, as long as the non-pluralized base exists in English.
 *
 * Exits 0 when all locales match the English locale; 1 with a diagnostic otherwise.
 *
 * Scope: this script intentionally only checks locale domains under
 * `packages/shared/src/i18n/locales`. It does NOT scan for hardcoded
 * strings — that's the job of `scripts/lint-i18n-staged.sh` (pre-commit).
 */

import { LOCALE_REGISTRY } from '../packages/shared/src/i18n/registry.ts'

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/

const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, '')
const isPluralKey = (key: string): boolean => PLURAL_SUFFIX.test(key)

const en = LOCALE_REGISTRY.en.messages
const enKeys = new Set(Object.keys(en))
const localeEntries = Object.entries(LOCALE_REGISTRY).filter(([lang]) => lang !== 'en')

const errors: string[] = []
for (const [lang, entry] of localeEntries) {
  const locale = entry.messages
  const otherKeys = new Set(Object.keys(locale))

  const missing: string[] = []
  for (const key of enKeys) {
    if (!otherKeys.has(key)) missing.push(key)
  }

  const extra: string[] = []
  for (const key of otherKeys) {
    if (enKeys.has(key)) continue
    if (isPluralKey(key)) {
      const base = pluralBase(key)
      if (enKeys.has(`${base}_one`) && enKeys.has(`${base}_other`)) continue
      if (enKeys.has(base)) continue
    }
    extra.push(key)
  }

  if (missing.length) {
    errors.push(
      `${lang}: ${missing.length} keys missing (e.g. ${missing.slice(0, 3).join(', ')})`,
    )
  }
  if (extra.length) {
    errors.push(
      `${lang}: ${extra.length} extra keys (e.g. ${extra.slice(0, 3).join(', ')})`,
    )
  }
}

if (errors.length) {
  console.error('i18n parity check failed:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

console.log(`i18n parity OK (${localeEntries.length} locales, ${enKeys.size} keys each)`)
