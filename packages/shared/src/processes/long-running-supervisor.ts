import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/files.ts';

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_REPORT_INTERVAL_MS = 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const EXITED_RETENTION_MS = 10 * 60 * 1000;

export interface LongRunningProcessRegistration {
  id: string;
  kind: string;
  ownerId: string;
  /** Maximum silence before the supervisor terminates the process tree. */
  maxIdleMs?: number;
  /** Active work may legitimately be silent; idle cleanup is deferred while busy. */
  isBusy?: () => boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface LongRunningProcessSnapshot {
  id: string;
  kind: string;
  ownerId: string;
  pid?: number;
  status: 'running' | 'terminating' | 'exited' | 'failed';
  startedAt: string;
  lastActivityAt: string;
  idleForMs: number;
  maxIdleMs: number;
  cpuPercent?: number;
  rssBytes?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  terminationReason?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface LongRunningHealthSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  status: 'ok' | 'degraded' | 'unhealthy';
  parent: {
    pid: number;
    uptimeSeconds: number;
    cpuPercent: number;
    cpuCount: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    rssBytes: number;
  };
  summary: {
    tracked: number;
    running: number;
    terminating: number;
    failed: number;
    suspectedOrphans: number;
  };
  processes: LongRunningProcessSnapshot[];
  suspectedOrphanPids: number[];
  reportError?: string;
}

export interface LongRunningProcessHandle {
  touch: () => void;
  terminate: (reason?: string) => void;
  release: (reason?: string) => void;
}

interface ProcessRecord {
  child: ChildProcess;
  registration: Required<Pick<LongRunningProcessRegistration, 'id' | 'kind' | 'ownerId'>> & LongRunningProcessRegistration;
  status: LongRunningProcessSnapshot['status'];
  startedAtMs: number;
  lastActivityAtMs: number;
  exitedAtMs?: number;
  cpuPercent?: number;
  rssBytes?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  terminationReason?: string;
  killTimer?: ReturnType<typeof setTimeout>;
}

interface ProcessTableEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface SupervisorStartOptions {
  healthReportPath?: string;
  sweepIntervalMs?: number;
  reportIntervalMs?: number;
  terminationGraceMs?: number;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function parseProcessTable(output: string): ProcessTableEntry[] {
  return output
    .trim()
    .split('\n')
    .map((line): ProcessTableEntry | undefined => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
      if (!match) return undefined;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return undefined;
      return { pid, ppid, command: match[3] ?? '' };
    })
    .filter((entry): entry is ProcessTableEntry => Boolean(entry));
}

function appBundleRoot(executablePath: string): string | undefined {
  const marker = '.app/Contents/MacOS/';
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex === -1) return undefined;
  return executablePath.slice(0, markerIndex + '.app'.length);
}

function isExpectedHostChild(command: string, hostExecutable = process.execPath): boolean {
  const bundleRoot = appBundleRoot(hostExecutable);
  if (!bundleRoot) return false;
  return command.startsWith(`${bundleRoot}/Contents/Frameworks/`) && command.includes(' --type=');
}

export function getSuspectedOrphanPidsFromProcessTable(
  output: string,
  parentPid: number,
  trackedPids: ReadonlySet<number>,
  previousSightings: ReadonlyMap<number, number>,
  hostExecutable = process.execPath,
): { pids: number[]; sightings: Map<number, number> } {
  const untracked = parseProcessTable(output)
    .filter((entry) => entry.ppid === parentPid)
    .filter((entry) => !trackedPids.has(entry.pid))
    .filter((entry) => !isExpectedHostChild(entry.command, hostExecutable))
    .map((entry) => entry.pid);
  const sightings = new Map<number, number>();
  for (const pid of untracked) sightings.set(pid, (previousSightings.get(pid) ?? 0) + 1);
  const pids = [...sightings]
    .filter(([, count]) => count >= 2)
    .map(([pid]) => pid)
    .sort((a, b) => a - b);
  return { pids, sightings };
}

export class LongRunningProcessSupervisor {
  private readonly records = new Map<string, ProcessRecord>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private reportTimer?: ReturnType<typeof setInterval>;
  private healthReportPath?: string;
  private terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleMs = Date.now();
  private parentCpuPercent = 0;
  private suspectedOrphanPids: number[] = [];
  private readonly orphanSightings = new Map<number, number>();
  private sweepInFlight = false;
  private reportError?: string;

  start(options: SupervisorStartOptions = {}): void {
    this.healthReportPath = options.healthReportPath ?? this.healthReportPath;
    this.terminationGraceMs = options.terminationGraceMs ?? this.terminationGraceMs;
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
    if (!this.reportTimer) {
      this.reportTimer = setInterval(() => this.writeHealthReport(), options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS);
      this.reportTimer.unref?.();
    }
    void this.sweep();
  }

  register(child: ChildProcess, registration: LongRunningProcessRegistration): LongRunningProcessHandle {
    const existing = this.records.get(registration.id);
    if (existing && existing.status !== 'exited' && existing.status !== 'failed') {
      throw new Error(`Long-running process id already registered: ${registration.id}`);
    }
    const now = Date.now();
    const record: ProcessRecord = {
      child,
      registration,
      status: 'running',
      startedAtMs: now,
      lastActivityAtMs: now,
    };
    this.records.set(registration.id, record);
    const touch = () => {
      if (record.status === 'running') record.lastActivityAtMs = Date.now();
    };
    child.stdout?.on('data', touch);
    child.stderr?.on('data', touch);
    child.on('message', touch);
    child.once('error', () => {
      record.status = 'failed';
      record.exitedAtMs = Date.now();
      if (record.killTimer) clearTimeout(record.killTimer);
    });
    child.once('exit', (code, signal) => {
      record.status = code === 0 || record.status === 'terminating' ? 'exited' : 'failed';
      record.exitCode = code;
      record.exitSignal = signal;
      record.exitedAtMs = Date.now();
      if (record.killTimer) clearTimeout(record.killTimer);
    });
    return {
      touch,
      terminate: (reason = 'owner-requested termination') => this.terminateRecord(record, reason),
      release: (reason = 'owner released process') => this.terminateRecord(record, reason),
    };
  }

  private terminateTree(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
      execFile('taskkill', args, () => undefined);
      return;
    }
    // Direct descendants are signalled before the parent so they cannot keep
    // inherited pipes or sockets alive after the registered owner exits.
    execFile('pkill', [`-${signal === 'SIGKILL' ? 'KILL' : 'TERM'}`, '-P', String(pid)], () => undefined);
    try {
      process.kill(pid, signal);
    } catch {
      // The normal exit listener will converge the record if it already died.
    }
  }

  private terminateRecord(record: ProcessRecord, reason: string): void {
    if (record.status !== 'running') return;
    record.status = 'terminating';
    record.terminationReason = reason;
    const pid = record.child.pid;
    if (!pid || !isAlive(pid)) {
      record.status = 'exited';
      record.exitedAtMs = Date.now();
      return;
    }
    this.terminateTree(pid, 'SIGTERM');
    record.killTimer = setTimeout(() => {
      if (record.status !== 'terminating' || !isAlive(pid)) return;
      this.terminateTree(pid, 'SIGKILL');
    }, this.terminationGraceMs);
    record.killTimer.unref?.();
  }

  private sampleParentCpu(now: number): void {
    const current = process.cpuUsage();
    const elapsedMicros = Math.max(1, (now - this.lastCpuSampleMs) * 1_000);
    const usedMicros = (current.user - this.lastCpuUsage.user) + (current.system - this.lastCpuUsage.system);
    this.parentCpuPercent = Math.round((usedMicros / elapsedMicros) * 10_000) / 100;
    this.lastCpuUsage = current;
    this.lastCpuSampleMs = now;
  }

  private async sampleChild(record: ProcessRecord): Promise<void> {
    const pid = record.child.pid;
    if (!pid || record.status !== 'running' || process.platform === 'win32') return;
    try {
      const output = await execFileText('ps', ['-o', '%cpu=,rss=', '-p', String(pid)]);
      const [cpu, rssKb] = output.trim().split(/\s+/).map(Number);
      if (Number.isFinite(cpu)) record.cpuPercent = cpu;
      if (rssKb !== undefined && Number.isFinite(rssKb)) record.rssBytes = rssKb * 1024;
    } catch {
      if (!isAlive(pid)) {
        record.status = 'failed';
        record.exitedAtMs = Date.now();
        record.terminationReason ??= 'process disappeared without an exit event';
      }
    }
  }

  private async detectSuspectedOrphans(): Promise<void> {
    if (process.platform === 'win32') {
      this.suspectedOrphanPids = [];
      return;
    }
    try {
      const output = await execFileText('ps', ['-axo', 'pid=,ppid=,command=']);
      const tracked = new Set(
        [...this.records.values()]
          .filter((record) => record.status === 'running' || record.status === 'terminating')
          .map((record) => record.child.pid)
          .filter((pid): pid is number => Boolean(pid)),
      );
      const { pids, sightings } = getSuspectedOrphanPidsFromProcessTable(
        output,
        process.pid,
        tracked,
        this.orphanSightings,
      );
      this.orphanSightings.clear();
      for (const [pid, count] of sightings) this.orphanSightings.set(pid, count);
      this.suspectedOrphanPids = pids;
    } catch {
      this.suspectedOrphanPids = [];
    }
  }

  async sweep(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      const now = Date.now();
      this.sampleParentCpu(now);
      for (const [id, record] of this.records) {
        if (record.status === 'running') {
          const maxIdleMs = record.registration.maxIdleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
          let isBusy = false;
          try {
            isBusy = record.registration.isBusy?.() === true;
          } catch {
            // A faulty owner callback must not break supervision for every
            // other registered process. Fall back to normal idle handling.
          }
          if (isBusy) {
            // Reset the idle baseline while active work is in flight so the
            // process also receives a full idle window after that work ends.
            record.lastActivityAtMs = now;
          } else if (now - record.lastActivityAtMs >= maxIdleMs) {
            this.terminateRecord(record, `idle timeout exceeded (${maxIdleMs} ms)`);
          }
        }
        if (record.exitedAtMs && now - record.exitedAtMs >= EXITED_RETENTION_MS) this.records.delete(id);
      }
      await Promise.all([...this.records.values()].map((record) => this.sampleChild(record)));
      await this.detectSuspectedOrphans();
      this.writeHealthReport();
    } finally {
      this.sweepInFlight = false;
    }
  }

  snapshot(now = Date.now()): LongRunningHealthSnapshot {
    const memory = process.memoryUsage();
    const processes = [...this.records.values()].map((record): LongRunningProcessSnapshot => ({
      id: record.registration.id,
      kind: record.registration.kind,
      ownerId: record.registration.ownerId,
      pid: record.child.pid,
      status: record.status,
      startedAt: new Date(record.startedAtMs).toISOString(),
      lastActivityAt: new Date(record.lastActivityAtMs).toISOString(),
      idleForMs: Math.max(0, now - record.lastActivityAtMs),
      maxIdleMs: record.registration.maxIdleMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      cpuPercent: record.cpuPercent,
      rssBytes: record.rssBytes,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      terminationReason: record.terminationReason,
      metadata: { ...(record.registration.metadata ?? {}) },
    }));
    const running = processes.filter((item) => item.status === 'running').length;
    const terminating = processes.filter((item) => item.status === 'terminating').length;
    const failed = processes.filter((item) => item.status === 'failed').length;
    const suspectedOrphans = this.suspectedOrphanPids.length;
    const status = failed > 0 || suspectedOrphans > 0
      ? 'unhealthy'
      : terminating > 0 || this.reportError
        ? 'degraded'
        : 'ok';
    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      status,
      parent: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        cpuPercent: this.parentCpuPercent,
        cpuCount: cpus().length,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        rssBytes: memory.rss,
      },
      summary: { tracked: processes.length, running, terminating, failed, suspectedOrphans },
      processes,
      suspectedOrphanPids: [...this.suspectedOrphanPids],
      ...(this.reportError ? { reportError: this.reportError } : {}),
    };
  }

  writeHealthReport(): void {
    if (!this.healthReportPath) return;
    try {
      this.reportError = undefined;
      mkdirSync(dirname(this.healthReportPath), { recursive: true });
      atomicWriteFileSync(this.healthReportPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
    } catch (error) {
      // Health reporting must never crash the long-running server. The RPC
      // snapshot degrades until a later report write succeeds.
      this.reportError = error instanceof Error ? error.message : String(error);
    }
  }

  shutdown(reason = 'server shutdown'): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.sweepTimer = undefined;
    this.reportTimer = undefined;
    for (const record of this.records.values()) this.terminateRecord(record, reason);
    this.writeHealthReport();
  }
}

export const longRunningProcessSupervisor = new LongRunningProcessSupervisor();

export const startLongRunningProcessSupervisor = (options?: SupervisorStartOptions): void =>
  longRunningProcessSupervisor.start(options);

export const registerLongRunningProcess = (
  child: ChildProcess,
  registration: LongRunningProcessRegistration,
): LongRunningProcessHandle => longRunningProcessSupervisor.register(child, registration);

export const getLongRunningHealthSnapshot = (): LongRunningHealthSnapshot =>
  longRunningProcessSupervisor.snapshot();

export const shutdownLongRunningProcessSupervisor = (reason?: string): void =>
  longRunningProcessSupervisor.shutdown(reason);
