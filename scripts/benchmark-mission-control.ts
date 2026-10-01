import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendMissionEvents,
  listMissionIds,
  type MissionEvent,
  type MissionSpec,
} from '../packages/shared/src/missions/index.ts';
import type { MissionSnapshotDto } from '../packages/shared/src/protocol/index.ts';
import { MissionController } from '../packages/server-core/src/missions/MissionController.ts';
import {
  filterAndSortMissions,
  getMissionAnalytics,
} from '../apps/electron/src/renderer/pages/mission-control-model.ts';

/**
 * Bounded Control Room qualification, not a CI gate.
 *
 * Server coverage mirrors the body of MissionRuntimeService.listMissions():
 * journal discovery, descriptor-confined reads, event validation/reduction and
 * updatedAt sorting. It excludes service startup/context construction and IPC.
 * UI coverage calls the production analytics/filter/sort functions and slices
 * the 50-row page. It excludes transport serialization, React and DOM painting.
 */
const MISSION_COUNT = 1_000;
const WORK_ITEMS_PER_MISSION = 10;
const PAGE_SIZE = 50;
const SERVER_SAMPLES = 30;
const UI_SAMPLES = 1_000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');
let sink = 0;

interface Distribution {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function measure(operation: () => unknown, warmups: number, samples: number): Distribution {
  for (let index = 0; index < warmups; index += 1) {
    const value = operation();
    if (Array.isArray(value)) sink += value.length;
  }
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const value = operation();
    durations.push(performance.now() - started);
    if (Array.isArray(value)) sink += value.length;
  }
  const sorted = durations.toSorted((left, right) => left - right);
  return {
    samples,
    minMs: sorted[0]!,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1)!,
    meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
  };
}

function workItems(missionIndex: number): MissionSpec['workItems'] {
  const objectiveId = `objective-${missionIndex}`;
  return [
    {
      id: objectiveId,
      kind: 'objective',
      title: `Objective ${missionIndex}`,
      acceptanceCriteria: [{ id: `objective-ok-${missionIndex}`, description: 'Objective accepted' }],
      requiredEvidence: [],
      dependsOn: [],
      effect: 'read',
    },
    ...Array.from({ length: WORK_ITEMS_PER_MISSION - 1 }, (_, itemIndex) => ({
      id: `task-${missionIndex}-${itemIndex}`,
      kind: itemIndex % 3 === 0 ? 'integration' as const : 'task' as const,
      title: `Task ${itemIndex}`,
      prompt: `Execute bounded task ${itemIndex}`,
      parentId: objectiveId,
      objectiveId,
      dependsOn: itemIndex === 0 ? [] : [`task-${missionIndex}-${itemIndex - 1}`],
      acceptanceCriteria: [{ id: `task-ok-${missionIndex}-${itemIndex}`, description: 'Task accepted' }],
      requiredEvidence: [{
        id: `evidence-${missionIndex}-${itemIndex}`,
        description: 'Host-observed artifact',
        kind: itemIndex % 2 === 0 ? 'test' as const : 'artifact' as const,
      }],
      agentProfileId: 'worker',
      effect: 'read' as const,
    })),
  ];
}

function specification(index: number): MissionSpec {
  const id = `mission-${String(index).padStart(4, '0')}`;
  return {
    schemaVersion: 2,
    id,
    title: `Mission ${String(index).padStart(4, '0')}`,
    objective: `Produce verified outcome ${index}`,
    acceptanceCriteria: [{ id: `mission-ok-${index}`, description: 'Mission accepted' }],
    originSessionId: `origin-${index}`,
    plannerSessionId: `planner-session-${index}`,
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    projectId: `project-${index % 8}`,
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'planning', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'execution', systemPrompt: 'Execute.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervision', systemPrompt: 'Supervise.' },
    ],
    policy: {
      maxConcurrentAgents: 4,
      maxCorrectionCycles: 3,
      maxWorkItems: 64,
      maxDepth: 4,
      maxTechnicalAttempts: 3,
      requireIndependentReview: true,
      requireIndependentSupervisor: true,
    },
    workItems: workItems(index),
  };
}

function journalEvents(index: number): MissionEvent[] {
  const createdAt = new Date(NOW - 4 * 60 * 60 * 1_000 - index * 1_000).toISOString();
  const updatedAt = new Date(NOW - (index % 240) * 60 * 1_000).toISOString();
  const statuses = [
    'running', 'running', 'blocked', 'paused', 'waiting-approval',
    'correcting', 'objective-review', 'completed', 'failed', 'cancelled',
  ] as const;
  const status = statuses[index % statuses.length]!;
  return [
    { kind: 'mission-created', at: createdAt, spec: specification(index) },
    {
      kind: 'mission-status-changed',
      at: updatedAt,
      status,
      ...(['blocked', 'waiting-approval'].includes(status) ? { reason: `Approval blocker ${index}` } : {}),
    },
  ];
}

function journalBytes(root: string): number {
  return readdirSync(join(root, 'missions')).reduce((bytes, missionId) =>
    bytes + statSync(join(root, 'missions', missionId, 'events.jsonl')).size, 0);
}

const workspaceRoot = mkdtempSync(join(tmpdir(), 'robb-control-room-benchmark-'));
try {
  const setupStarted = performance.now();
  for (let index = 0; index < MISSION_COUNT; index += 1) {
    appendMissionEvents(workspaceRoot, `mission-${String(index).padStart(4, '0')}`, journalEvents(index), 0);
  }
  const setupMs = performance.now() - setupStarted;
  const controller = new MissionController({ workspaceRoot });
  const listOnly = () => listMissionIds(workspaceRoot);
  const ids = listOnly();
  const projectKnownIds = () => ids
    .map((missionId) => controller.getMission(missionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const serverEndToEnd = () => listMissionIds(workspaceRoot)
    .map((missionId) => controller.getMission(missionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const firstStarted = performance.now();
  const dto = serverEndToEnd() as MissionSnapshotDto[];
  const firstServerMs = performance.now() - firstStarted;
  const uiAll = () => {
    const filtered = filterAndSortMissions(dto, {
      query: '', status: 'all', risk: 'all', projectId: '',
    }, NOW);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const visible = filtered.slice(0, PAGE_SIZE);
    sink += pageCount + visible.length;
    return visible;
  };
  const uiSelective = () => {
    const filtered = filterAndSortMissions(dto, {
      query: 'mission 00', status: 'active', risk: 'breach', projectId: 'project-3',
    }, NOW);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const visible = filtered.slice(0, PAGE_SIZE);
    sink += pageCount + visible.length;
    return visible;
  };
  const uiFullDerivedModel = () => {
    const visible = uiAll();
    const projects = [...new Set(dto.map((mission) => mission.spec.projectId).filter(Boolean))].sort();
    const portfolio = dto.reduce((summary, mission) => {
      const analytics = getMissionAnalytics(mission, NOW);
      summary.blockers += analytics.blockerCount;
      summary.costUsd += analytics.costUsd;
      summary.evidence += analytics.hashedEvidence;
      return summary;
    }, { blockers: 0, costUsd: 0, evidence: 0 });
    sink += projects.length + portfolio.blockers + portfolio.evidence;
    return visible;
  };

  process.stdout.write(`${JSON.stringify({
    benchmarkVersion: 1,
    environment: {
      runtime: `Bun ${Bun.version}`,
      platform: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    fixture: {
      missionCount: MISSION_COUNT,
      workItemsPerMission: WORK_ITEMS_PER_MISSION,
      journalBytes: journalBytes(workspaceRoot),
      setupMs,
      tempWorkspaceRemovedAfterRun: true,
    },
    server: {
      firstEndToEndMs: firstServerMs,
      listIds: measure(listOnly, 3, SERVER_SAMPLES),
      projectKnownIds: measure(projectKnownIds, 3, SERVER_SAMPLES),
      endToEndListProjectSort: measure(serverEndToEnd, 3, SERVER_SAMPLES),
    },
    ui: {
      allFilterSortPage50: measure(uiAll, 100, UI_SAMPLES),
      selectiveFilterSortPage50: measure(uiSelective, 100, UI_SAMPLES),
      allPlusPortfolioAndProjects: measure(uiFullDerivedModel, 100, UI_SAMPLES),
    },
    sink,
  }, null, 2)}\n`);
} finally {
  rmSync(workspaceRoot, { recursive: true, force: true });
}
