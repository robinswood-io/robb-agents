import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  convertDocumentToMarkdown,
  resolveMarkitdownScript,
  type DocumentConverterExecutor,
} from './document-converter'

async function createFixture(): Promise<{
  root: string
  scriptPath: string
  inputPath: string
}> {
  const root = join(tmpdir(), `robb-document-converter-${randomUUID()}`)
  const scriptsPath = join(root, 'resources', 'scripts')
  const scriptPath = join(scriptsPath, 'markitdown_cli.py')
  const inputPath = join(root, 'document.docx')
  await mkdir(scriptsPath, { recursive: true })
  await writeFile(scriptPath, '# test fixture\n', 'utf8')
  await writeFile(inputPath, 'document fixture', 'utf8')
  return { root, scriptPath, inputPath }
}

describe('document converter', () => {
  test('uses the bundled converter with direct arguments and no shell', async () => {
    const fixture = await createFixture()
    let invocation:
      | { executable: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }
      | undefined
    const execute: DocumentConverterExecutor = async (executable, args, options) => {
      invocation = { executable, args, ...options }
      return { stdout: '# Converted document\n', stderr: '' }
    }

    try {
      const markdown = await convertDocumentToMarkdown(fixture.inputPath, {
        appRootPath: fixture.root,
        resourcesPath: fixture.root,
        environment: {
          CRAFT_UV: '/trusted/bin/uv',
          CRAFT_SCRIPTS: join(fixture.root, 'resources', 'scripts'),
        },
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        execute,
      })

      expect(markdown).toBe('# Converted document\n')
      expect(invocation).toEqual({
        executable: '/trusted/bin/uv',
        args: ['run', '--python', '3.12', fixture.scriptPath, fixture.inputPath],
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('resolves the development script from the application root', async () => {
    const fixture = await createFixture()

    try {
      expect(resolveMarkitdownScript({
        appRootPath: fixture.root,
        resourcesPath: join(fixture.root, 'unrelated'),
        environment: {},
      })).toBe(fixture.scriptPath)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects empty conversion output', async () => {
    const fixture = await createFixture()

    try {
      await expect(convertDocumentToMarkdown(fixture.inputPath, {
        appRootPath: fixture.root,
        resourcesPath: fixture.root,
        environment: {
          CRAFT_SCRIPTS: join(fixture.root, 'resources', 'scripts'),
        },
        execute: async () => ({ stdout: '  \n', stderr: '' }),
      })).rejects.toThrow('empty result')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
