#!/usr/bin/env bun
/**
 * Reports translation coverage and rejects invalid locale values.
 *
 * Parity (key presence) is checked separately. This script ensures values are
 * non-empty and makes English fallbacks visible without treating them as an
 * error: new product strings may intentionally ship with a safe fallback while
 * a native translation is pending.
 */
import { LOCALE_REGISTRY } from '../packages/shared/src/i18n/registry.ts'

type Locale = Record<string, string>
const english: Locale = LOCALE_REGISTRY.en.messages
const keys = Object.keys(english)
const errors: string[] = []

for (const [file, entry] of Object.entries(LOCALE_REGISTRY).filter(([lang]) => lang !== 'en')) {
  const locale: Locale = entry.messages
  let translated = 0
  let fallback = 0

  for (const key of keys) {
    const value = locale[key]
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${file}: empty value for ${key}`)
      continue
    }
    if (value === english[key]) fallback += 1
    else translated += 1
  }

  const percent = keys.length === 0 ? 100 : Math.round((translated / keys.length) * 100)
  console.log(`${file}: ${translated}/${keys.length} translated (${percent}%), ${fallback} English fallbacks`)
}

if (errors.length > 0) {
  console.error('i18n coverage check failed:')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}
