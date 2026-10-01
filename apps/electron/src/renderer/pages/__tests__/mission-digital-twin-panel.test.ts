import { describe, expect, it } from 'bun:test'
import type { MissionSnapshotDto } from '@craft-agent/shared/protocol'
import { missionDigitalTwinPanelInternals } from '../mission-digital-twin-panel'

const validWorkItems = [
  {
    id: 'objective-a',
    kind: 'objective',
    title: 'Objective A',
    acceptanceCriteria: [{ id: 'criterion-a', description: 'A passes' }],
  },
  {
    id: 'objective-b',
    kind: 'objective',
    title: 'Objective B',
    acceptanceCriteria: [{ id: 'criterion-b', description: 'B passes' }],
  },
]

describe('Mission digital twin panel model', () => {
  it('accepts a structurally valid work-item array before authoritative host validation', () => {
    const parsed = missionDigitalTwinPanelInternals.parseProposedWorkItems(JSON.stringify(validWorkItems))

    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.id).toBe('objective-a')
  })

  it('rejects malformed JSON and mutation work without a broker invocation', () => {
    expect(() => missionDigitalTwinPanelInternals.parseProposedWorkItems('{')).toThrow()
    expect(() => missionDigitalTwinPanelInternals.parseProposedWorkItems(JSON.stringify([
      validWorkItems[0],
      {
        id: 'mutate-provider',
        kind: 'task',
        title: 'Mutate provider',
        prompt: 'Apply the update',
        objectiveId: 'objective-a',
        acceptanceCriteria: [{ id: 'mutation-applied', description: 'Applied once' }],
        effect: 'external-mutation',
      },
    ]))).toThrow('structured brokered connector invocation')
  })

  it('requires a material plan diff before apply can be enabled', () => {
    const unchanged = {
      addedWorkItemIds: [],
      removedWorkItemIds: [],
      changedWorkItemIds: [],
    }
    const changed = { ...unchanged, changedWorkItemIds: ['objective-a'] }

    expect(missionDigitalTwinPanelInternals.previewHasChanges(unchanged as never)).toBe(false)
    expect(missionDigitalTwinPanelInternals.previewHasChanges(changed as never)).toBe(true)
  })

  it('locally prevents apply for terminal Missions and reserved or running leases', () => {
    const snapshot = (status: string, itemStatus: string) => ({
      status,
      workItems: { source: { status: itemStatus } },
    }) as unknown as MissionSnapshotDto

    expect(missionDigitalTwinPanelInternals.missionCanReplan(snapshot('paused', 'pending'))).toBe(true)
    expect(missionDigitalTwinPanelInternals.missionCanReplan(snapshot('completed', 'pending'))).toBe(false)
    expect(missionDigitalTwinPanelInternals.missionCanReplan(snapshot('paused', 'reserved'))).toBe(false)
    expect(missionDigitalTwinPanelInternals.missionCanReplan(snapshot('paused', 'running'))).toBe(false)
  })

  it('rejects mismatched dry-run and revision contracts from the host', () => {
    const identity = { workspaceId: 'workspace-1', missionId: 'mission-1', revision: 7 }
    const preflight = {
      missionId: 'mission-1',
      mode: 'dry-run',
      mutationMode: 'forbidden',
    }
    const preview = { missionId: 'mission-1', baseRevision: 7 }

    expect(missionDigitalTwinPanelInternals.assertPreflightContract(preflight as never, identity))
      .toBe(preflight as never)
    expect(() => missionDigitalTwinPanelInternals.assertPreflightContract({
      ...preflight,
      mutationMode: 'allowed',
    } as never, identity)).toThrow(/dry-run/)
    expect(missionDigitalTwinPanelInternals.assertPreviewContract(preview as never, identity))
      .toBe(preview as never)
    expect(() => missionDigitalTwinPanelInternals.assertPreviewContract({
      ...preview,
      baseRevision: 6,
    } as never, identity)).toThrow(/stale/)
  })

  it('invalidates a preview when identity, revision or edited text changes', () => {
    const identity = { workspaceId: 'workspace-1', missionId: 'mission-1', revision: 7 }
    const preview = { missionId: 'mission-1', baseRevision: 7 }

    expect(missionDigitalTwinPanelInternals.previewMatchesMission(
      preview as never, '[{"id":"a"}]', '[{"id":"a"}]', identity,
    )).toBe(true)
    expect(missionDigitalTwinPanelInternals.previewMatchesMission(
      preview as never, '[{"id":"a"}]', '[{"id":"b"}]', identity,
    )).toBe(false)
    expect(missionDigitalTwinPanelInternals.previewMatchesMission(
      { ...preview, baseRevision: 6 } as never, '[{"id":"a"}]', '[{"id":"a"}]', identity,
    )).toBe(false)
    expect(missionDigitalTwinPanelInternals.requestIdentityMatches(
      identity,
      { ...identity, workspaceId: 'workspace-2' },
    )).toBe(false)
  })
})
