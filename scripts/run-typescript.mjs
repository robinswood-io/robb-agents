import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const [, , flavor, ...args] = process.argv
if (flavor !== 'native' && flavor !== 'compat') {
  console.error('Usage: node scripts/run-typescript.mjs <native|compat> [...tsc args]')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const packageName = flavor === 'native' ? '@typescript/native' : 'typescript'
const packageJsonPath = require.resolve(`${packageName}/package.json`)
const cliPath = resolve(dirname(packageJsonPath), 'bin', 'tsc')
const result = spawnSync(process.execPath, [cliPath, ...args], { stdio: 'inherit' })

if (result.error) {
  throw result.error
}
if (result.signal) {
  console.error(`TypeScript ${flavor} terminated by signal ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
