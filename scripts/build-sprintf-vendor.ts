import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformSync } from 'esbuild'
const directory = resolve(import.meta.dirname, 'vendor/sprintf-js/src')
const target = resolve(directory, 'sprintf.js')
const result = transformSync(readFileSync(resolve(directory, 'sprintf.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: 'sprintf.ts',
  banner: '// Generated from sprintf.ts by scripts/build-sprintf-vendor.ts; do not edit.',
}).code
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== result) throw new Error('Generated sprintf payload is stale')
} else {
  writeFileSync(target, result)
}
