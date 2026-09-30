import { describe, expect, it } from 'bun:test'
import { buildBranchSessionOptions, resolveBranchNewPanelOption } from '../branching'

describe('ChatDisplay branching navigation option', () => {
  it('defaults to opening in new panel when options are missing', () => {
    expect(resolveBranchNewPanelOption(undefined)).toBe(true)
  })

  it('respects explicit newPanel=false', () => {
    expect(resolveBranchNewPanelOption({ newPanel: false })).toBe(false)
  })

  it('respects explicit newPanel=true', () => {
    expect(resolveBranchNewPanelOption({ newPanel: true })).toBe(true)
  })
})

describe('ChatDisplay branch route provenance', () => {
  const parent = {
    id: 'parent',
    name: 'Automatic route',
    llmConnection: 'workspace-default',
    model: 'pi/gpt-5.6-terra',
    thinkingLevel: 'medium' as const,
    permissionMode: 'ask' as const,
    workingDirectory: '/tmp/project',
  }

  it('copies the effective route without converting an automatic route into a manual pin', () => {
    expect(buildBranchSessionOptions(parent, 'message-1')).toEqual({
      branchFromMessageId: 'message-1',
      branchFromSessionId: 'parent',
      name: 'Branch of Automatic route',
      llmConnection: 'workspace-default',
      connectionRoutePinned: false,
      model: 'pi/gpt-5.6-terra',
      modelRoutePinned: false,
      thinkingLevel: 'medium',
      thinkingLevelPinned: false,
      permissionMode: 'ask',
      workingDirectory: '/tmp/project',
    })
  })

  it('preserves all three authenticated manual pins', () => {
    expect(buildBranchSessionOptions({
      ...parent,
      connectionRoutePinned: true,
      modelRoutePinned: true,
      thinkingLevelPinned: true,
    }, 'message-2')).toMatchObject({
      connectionRoutePinned: true,
      modelRoutePinned: true,
      thinkingLevel: 'medium',
      thinkingLevelPinned: true,
    })
  })

  it('repairs a legacy model pin by pinning its copied provider scope', () => {
    expect(buildBranchSessionOptions({
      ...parent,
      connectionRoutePinned: false,
      modelRoutePinned: true,
    }, 'message-3')).toMatchObject({
      llmConnection: 'workspace-default',
      connectionRoutePinned: true,
      modelRoutePinned: true,
    })
  })
})
