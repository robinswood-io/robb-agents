import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import type { MissionWorkItem } from '@craft-agent/shared/missions';
import { resolveMissionSubmissionEvidence } from './MissionEvidenceResolver.ts';

const item: MissionWorkItem = {
  id: 'task-a',
  kind: 'task',
  title: 'Task A',
  prompt: 'Run the test',
  objectiveId: 'objective-a',
  dependsOn: [],
  acceptanceCriteria: [{ id: 'criterion-a', description: 'Passes' }],
  requiredEvidence: [{ id: 'test-a', description: 'Test report', kind: 'test' }],
  effect: 'read',
};

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'robb-mission-evidence-'));
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'reports', 'test.json'), '{"passed":true}\n');
  return root;
}

describe('resolveMissionSubmissionEvidence', () => {
  it('opens, hashes, and rewrites a workspace evidence reference', () => {
    const root = workspace();
    const resolved = resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      observedAt: '2026-08-20T10:00:00.000Z',
      submission: {
        summary: 'Done',
        outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'reports/test.json' }],
      },
    });
    const expected = createHash('sha256').update('{"passed":true}\n').digest('hex');
    expect(resolved.submission.evidence[0]).toMatchObject({
      uri: 'workspace:///reports/test.json',
      sha256: expected,
    });
    expect(resolved.evidence[0]).toMatchObject({
      workItemId: 'task-a',
      sizeBytes: 16,
      provenance: 'workspace-file',
    });
  });

  it('rejects opaque model-authored URIs', () => {
    const root = workspace();
    expect(() => resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      submission: {
        summary: 'Done', outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'https://example.test/report' }],
      },
    })).toThrow('not host-resolvable');
  });

  it('rejects a symlink that leaves the workspace', () => {
    const root = workspace();
    const outside = join(mkdtempSync(join(tmpdir(), 'robb-outside-')), 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'reports', 'escape.txt'));
    expect(() => resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      submission: {
        summary: 'Done', outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'reports/escape.txt' }],
      },
    })).toThrow('escapes the workspace boundary');
  });

  it('rejects path traversal before opening an evidence file', () => {
    const root = workspace();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'robb-outside-'));
    writeFileSync(join(outsideRoot, 'secret.txt'), 'secret');
    try {
      expect(() => resolveMissionSubmissionEvidence({
        workspaceRoot: root,
        item,
        submission: {
          summary: 'Done', outputRefs: [],
          evidence: [{ requirementId: 'test-a', kind: 'test', uri: `../${basename(outsideRoot)}/secret.txt` }],
        },
      })).toThrow('escapes the workspace boundary');
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked intermediate directory even when its target is inside the workspace', () => {
    const root = workspace();
    symlinkSync(join(root, 'reports'), join(root, 'reports-alias'), 'dir');
    expect(() => resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      submission: {
        summary: 'Done', outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'reports-alias/test.json' }],
      },
    })).toThrow(/symbolic link/);
  });

  it('rejects workspace URI authorities instead of interpreting them as local paths', () => {
    const root = workspace();
    expect(() => resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      submission: {
        summary: 'Done', outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'workspace://attacker/reports/test.json' }],
      },
    })).toThrow(/authority/);
  });

  it('rejects a declared hash that differs from the observed bytes', () => {
    const root = workspace();
    expect(() => resolveMissionSubmissionEvidence({
      workspaceRoot: root,
      item,
      submission: {
        summary: 'Done', outputRefs: [],
        evidence: [{ requirementId: 'test-a', kind: 'test', uri: 'reports/test.json', sha256: '0'.repeat(64) }],
      },
    })).toThrow('does not match');
  });
});
