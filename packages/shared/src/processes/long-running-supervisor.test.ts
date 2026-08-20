import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { LongRunningProcessSupervisor } from './long-running-supervisor.ts';

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return child;
}

describe('long-running process supervisor', () => {
  it('tracks activity and terminates a silent child after its bounded idle timeout', async () => {
    const supervisor = new LongRunningProcessSupervisor();
    const child = fakeChild();
    supervisor.register(child, {
      id: 'agent:session-1',
      kind: 'agent-runtime',
      ownerId: 'session-1',
      maxIdleMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.sweep();

    const snapshot = supervisor.snapshot();
    expect(snapshot.processes[0]?.status).toBe('exited');
    expect(snapshot.processes[0]?.terminationReason).toContain('idle timeout exceeded');
  });

  it('does not terminate a silent child while its owner reports active work', async () => {
    const supervisor = new LongRunningProcessSupervisor();
    const child = fakeChild();
    let isBusy = true;
    supervisor.register(child, {
      id: 'agent:session-busy',
      kind: 'agent-runtime',
      ownerId: 'session-busy',
      maxIdleMs: 5,
      isBusy: () => isBusy,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.sweep();
    expect(supervisor.snapshot().processes[0]?.status).toBe('running');

    isBusy = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.sweep();
    expect(supervisor.snapshot().processes[0]?.status).toBe('exited');
    expect(supervisor.snapshot().processes[0]?.terminationReason).toContain('idle timeout exceeded');
  });

  it('writes a recurring-health compatible report with CPU, memory, and child summary', () => {
    const supervisor = new LongRunningProcessSupervisor();
    const root = mkdtempSync(join(tmpdir(), 'robb-health-'));
    const reportPath = join(root, 'health', 'long-running.json');
    supervisor.start({ healthReportPath: reportPath, sweepIntervalMs: 60_000, reportIntervalMs: 60_000 });
    supervisor.writeHealthReport();
    supervisor.shutdown('test complete');

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReturnType<LongRunningProcessSupervisor['snapshot']>;
    expect(report.schemaVersion).toBe(1);
    expect(report.parent.pid).toBe(process.pid);
    expect(report.parent.rssBytes).toBeGreaterThan(0);
    expect(report.summary.tracked).toBe(0);
  });

  it('degrades health instead of crashing when the recurring report cannot be written', () => {
    const supervisor = new LongRunningProcessSupervisor();
    const root = mkdtempSync(join(tmpdir(), 'robb-health-failure-'));
    const blockingFile = join(root, 'not-a-directory');
    writeFileSync(blockingFile, 'occupied');

    supervisor.start({
      healthReportPath: join(blockingFile, 'health.json'),
      sweepIntervalMs: 60_000,
      reportIntervalMs: 60_000,
    });
    supervisor.writeHealthReport();

    expect(supervisor.snapshot().status).toBe('degraded');
    expect(supervisor.snapshot().reportError).toBeTruthy();
    supervisor.shutdown('test complete');
  });
});
