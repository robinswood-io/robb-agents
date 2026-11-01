import { describe, expect, it } from 'bun:test'
import { requestClientConfirmDialog, requestClientOpenFileDialog, requestClientOpenPath } from '../capabilities'
import type { RpcServer } from '../types'

function clientResponse(value: unknown): RpcServer {
  return {
    handle() {},
    push() {},
    async invokeClient() { return value },
    hasClientCapability: () => true,
    findClientsWithCapability: () => ['fixture-client'],
  }
}

const validFileSelections: Array<{ canceled: boolean; filePaths: string[] }> = [
  { canceled: false, filePaths: ['/tmp/fixture.txt'] },
  { canceled: true, filePaths: [] },
]

describe('native capability response contracts', () => {
  it('preserves valid confirmation data and a zero button index', async () => {
    const reply = { response: 0, checkboxChecked: true }
    expect(await requestClientConfirmDialog(clientResponse(reply), 'fixture-client', {
      title: 'Fixture', message: 'Continue?', buttons: ['Continue', 'Cancel'],
    })).toEqual(reply)
  })

  it.each([null, {}, { response: '0' }])('rejects malformed confirmation %j', async reply => {
    await expect(requestClientConfirmDialog(clientResponse(reply), 'fixture-client', {
      title: 'Fixture', message: 'Continue?', buttons: ['Continue', 'Cancel'],
    })).rejects.toThrow('Invalid confirmation response')
  })

  it.each(validFileSelections)('preserves a valid file selection %j', async reply => {
    expect(await requestClientOpenFileDialog(clientResponse(reply), 'fixture-client', {})).toEqual(reply)
  })

  it.each([null, {}, { canceled: 'false', filePaths: [] }, { canceled: false, filePaths: [42] }])(
    'rejects malformed file selection %j', async reply => {
      await expect(requestClientOpenFileDialog(clientResponse(reply), 'fixture-client', {})).rejects.toThrow('Invalid file')
    },
  )

  it('keeps open-path errors explicit, including malformed remote results', async () => {
    const reply = { error: 'Fixture application unavailable' }
    expect(await requestClientOpenPath(clientResponse(reply), 'fixture-client', '/tmp/fixture.txt')).toBe(reply)
    expect(await requestClientOpenPath(clientResponse(null), 'fixture-client', '/tmp/fixture.txt')).toEqual({})
    expect(await requestClientOpenPath(clientResponse({ error: 42 }), 'fixture-client', '/tmp/fixture.txt'))
      .toEqual({ error: 'Invalid open-path response from client' })
  })
})
