#!/usr/bin/env bun
/**
 * Reports translation coverage and rejects invalid locale values.
 *
 * Parity (key presence) is checked separately. This script ensures values are
 * non-empty and makes English fallbacks visible without treating them as an
 * error: new product strings may intentionally ship with a safe fallback while
 * a native translation is pending.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const localesDir = resolve(import.meta.dir, '..', 'packages', 'shared', 'src', 'i18n', 'locales')
type Locale = Record<string, string>

function loadLocale(name: string): Locale {
  return JSON.parse(readFileSync(resolve(localesDir, name), 'utf8')) as Locale
}

const english = loadLocale('en.json')
const keys = Object.keys(english)
const errors: string[] = []

for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json') && name !== 'en.json').sort()) {
  const locale = loadLocale(file)
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
