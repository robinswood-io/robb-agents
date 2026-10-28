import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dir, '..', '..')
const script = process.env["ROBB_QA_RELEASE_SOURCE_SCRIPT"] ?? join(root, 'scripts', 'robinswood-prepare-release-source.sh')
const temporary: string[] = []
const head = 'a'.repeat(40)

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function run(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'robb-release-source-'))
  temporary.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const commands = {
    node: 'case "$2" in *apps/electron*) printf "%s\\n" "$QA_APP_VERSION" ;; *) printf "%s\\n" "$QA_ROOT_VERSION" ;; esac',
    git: 'case "$1" in rev-list) printf "%s\\n" "$QA_TAG_SHA" ;; rev-parse) printf "%s\\n" "$QA_HEAD_SHA" ;; *) exit 2 ;; esac',
    python3: 'exit "$QA_PREFLIGHT_EXIT"',
    gh: '[ "$QA_RELEASE_EXISTS" = "true" ]',
  }
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$QA_CALLS"\n${body}\n`, { mode: 0o755 })
  }
  const output = join(directory, 'output')
  const calls = join(directory, 'calls')
  // Only fake release inputs reach the subprocess; no inherited credentials.
  const env = {
    PATH: bin + delimiter + (process.env["PATH"] ?? ''),
    GITHUB_OUTPUT: output,
    GITHUB_REF_NAME: 'qa-branch',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REPOSITORY: 'qa/release',
    REQUESTED_MODE: 'test-artifacts',
    REQUESTED_TAG: '',
    WINDOWS_SIGNING_MODE: 'unsigned',
    QA_CALLS: calls,
    QA_APP_VERSION: '1.2.3',
    QA_ROOT_VERSION: '1.2.3',
    QA_HEAD_SHA: head,
    QA_TAG_SHA: head,
    QA_PREFLIGHT_EXIT: '0',
    QA_RELEASE_EXISTS: 'false',
    ...overrides,
  }
  const result = spawnSync('bash', [script], { cwd: root, env, encoding: 'utf8' })
  if (result.error) throw result.error
  return {
    status: result.status,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const signed = { REQUESTED_MODE: 'publish-signed', REQUESTED_TAG: 'v1.2.3' }

describe.skipIf(process.platform === 'win32')('native release source preflight', () => {
  it('keeps test artifacts private to CI and records the exact source', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.output).toContain('publish=false\n')
    expect(result.output).toContain('tag=test-aaaaaaaaaaaa\n')
    expect(result.output).toContain(`source_commit=${head}\n`)
    expect(result.calls).not.toContain('python3 ')
    expect(result.calls).not.toContain('gh ')
  })

  it('rejects a root/application version mismatch before publication checks', () => {
    const result = run({ QA_ROOT_VERSION: '9.9.9' })
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
    expect(result.calls).not.toContain('gh ')
  })

  it('rejects an unsupported release mode', () => {
    const result = run({ REQUESTED_MODE: 'unexpected' })
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
  })

  it('requires strict signing preflight for a pushed stable tag', () => {
    const result = run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', REQUESTED_MODE: '' })
    expect(result.status).toBe(0)
    expect(result.output).toContain('publish=true\n')
    expect(result.output).toContain('tag=v1.2.3\n')
    expect(result.calls).toContain('python3 scripts/robinswood-signing-preflight.py --ci --strict')
    expect(result.calls).toContain('gh release view v1.2.3 --repo qa/release')
  })

  it('rejects a tag which does not match the application version', () => {
    const result = run({ ...signed, REQUESTED_TAG: 'v9.9.9' })
    expect(result.status).toBe(1)
    expect(result.calls).not.toContain('python3 ')
    expect(result.output).toBe('')
  })

  it('rejects source drift from the immutable tag', () => {
    const result = run({ ...signed, QA_TAG_SHA: 'b'.repeat(40) })
    expect(result.status).toBe(1)
    expect(result.calls).not.toContain('python3 ')
    expect(result.output).toBe('')
  })

  it('stops immediately when strict signing preflight fails', () => {
    const result = run({ ...signed, QA_PREFLIGHT_EXIT: '7' })
    expect(result.status).toBe(7)
    expect(result.calls).not.toContain('gh ')
    expect(result.output).toBe('')
  })

  it('rejects missing PFX credentials before querying GitHub', () => {
    const result = run({ ...signed, WINDOWS_SIGNING_MODE: 'pfx' })
    expect(result.status).toBe(1)
    expect(result.calls).not.toContain('gh ')
    expect(result.output).toBe('')
  })

  it('rejects an incomplete Azure signing configuration', () => {
    const result = run({ ...signed, WINDOWS_SIGNING_MODE: 'azure' })
    expect(result.status).toBe(1)
    expect(result.calls).not.toContain('gh ')
    expect(result.output).toBe('')
  })

  it('refuses to overwrite an existing GitHub release', () => {
    const result = run({ ...signed, QA_RELEASE_EXISTS: 'true' })
    expect(result.status).toBe(1)
    expect(result.calls).toContain('gh release view')
    expect(result.output).toBe('')
  })

  it('rejects unsupported Windows signing modes', () => {
    const result = run({ ...signed, WINDOWS_SIGNING_MODE: 'unexpected' })
    expect(result.status).toBe(1)
    expect(result.calls).not.toContain('gh ')
    expect(result.output).toBe('')
  })
})
