import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecutionTelemetrySink, OtlpPayloads, OtlpSignal, OtlpTelemetryConfig, ResolvedBatchConfig, RobbExecutionTelemetryEvent, TelemetryFetch, TelemetrySinkStats } from './contracts.ts';
import { resolveBatchConfig } from './otlp-config.ts';
import { buildOtlpPayloads, isOtlpPayloads, mergeOtlpPayloads } from './payloads.ts';

function signalUrl(endpoint: string, signal: OtlpSignal): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

export class TelemetryBackpressureError extends Error {
  constructor() {
    super('Telemetry queue is full and no durable spool is configured')
    this.name = 'TelemetryBackpressureError'
  }
}

export class OtlpHttpTelemetrySink implements ExecutionTelemetrySink {
  private readonly fetchFn: TelemetryFetch
  private readonly batchConfig: ResolvedBatchConfig
  private readonly queue: OtlpPayloads[] = []
  private readonly counters: Omit<TelemetrySinkStats, 'queued'> = {
    exported: 0,
    spooled: 0,
    dropped: 0,
    exportFailures: 0,
  }
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushPromise: Promise<void> | undefined
  private spoolOperation: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: OtlpTelemetryConfig,
    fetchFn: TelemetryFetch = fetch,
  ) {
    this.fetchFn = fetchFn
    this.batchConfig = resolveBatchConfig(config)
  }

  getStats(): TelemetrySinkStats {
    return {
      queued: this.queue.length,
      ...this.counters,
    }
  }

  async emit(event: RobbExecutionTelemetryEvent): Promise<void> {
    if (!this.config.enabled) return

    const payloads = buildOtlpPayloads(event, this.config)
    if (!this.batchConfig.enabled) {
      await this.exportWithRetry(payloads)
      this.counters.exported += 1
      return
    }

    if (this.queue.length >= this.batchConfig.maxQueueSize) {
      if (this.batchConfig.spoolPath) {
        await this.appendSpool([payloads])
        this.counters.spooled += 1
        return
      }
      this.counters.dropped += 1
      throw new TelemetryBackpressureError()
    }

    this.queue.push(payloads)
    if (this.queue.length >= this.batchConfig.maxBatchSize) {
      await this.flush()
      return
    }
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (!this.config.enabled) return
    if (this.flushPromise) return this.flushPromise

    this.cancelScheduledFlush()
    this.flushPromise = this.flushInternal().finally(() => {
      this.flushPromise = undefined
      if (this.queue.length > 0) this.scheduleFlush()
    })
    return this.flushPromise
  }

  async shutdown(): Promise<void> {
    this.cancelScheduledFlush()
    while (this.queue.length > 0) await this.flush()
    if (this.batchConfig.spoolPath) await this.replaySpool()
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.queue.length === 0) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, this.batchConfig.flushIntervalMs)
    if (typeof this.flushTimer !== 'number') this.flushTimer.unref()
  }

  private cancelScheduledFlush(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }

  private async flushInternal(): Promise<void> {
    if (this.batchConfig.spoolPath) await this.replaySpool()
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0, this.batchConfig.maxBatchSize)
    try {
      await this.exportWithRetry(mergeOtlpPayloads(batch))
      this.counters.exported += batch.length
    } catch (error) {
      if (this.batchConfig.spoolPath) {
        await this.appendSpool(batch)
        this.counters.spooled += batch.length
        return
      }
      this.queue.unshift(...batch)
      throw error
    }
  }

  private async exportWithRetry(payloads: OtlpPayloads): Promise<void> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.batchConfig.maxRetries; attempt += 1) {
      try {
        await this.exportPayloads(payloads)
        return
      } catch (error) {
        this.counters.exportFailures += 1
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.batchConfig.maxRetries) {
          await wait(this.batchConfig.retryBaseMs * (2 ** attempt))
        }
      }
    }
    throw lastError ?? new Error('OTLP export failed')
  }

  private async exportPayloads(payloads: OtlpPayloads): Promise<void> {
    const entries = Object.entries<unknown>((payloads as Record<string, unknown>)) as Array<
      [OtlpSignal, Record<string, unknown>]
    >
    await Promise.all(entries.map(async ([signal, payload]) => {
      const response = await this.fetchFn(signalUrl(this.config.endpoint, signal), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(`OTLP ${signal} export failed with HTTP ${response.status}`)
      }
    }))
  }

  private async appendSpool(payloads: OtlpPayloads[]): Promise<void> {
    return this.withSpoolLock(() => this.appendSpoolUnlocked(payloads))
  }

  private async appendSpoolUnlocked(payloads: OtlpPayloads[]): Promise<void> {
    const spoolPath = this.batchConfig.spoolPath
    if (!spoolPath || payloads.length === 0) return

    await mkdir(dirname(spoolPath), { recursive: true })
    const existing = await readFile(spoolPath, 'utf8').catch(() => '')
    const additions = payloads.map(payload => JSON.stringify(payload))
    const lines = [
      ...existing.split('\n').filter(Boolean),
      ...additions,
    ]
    let bytes = 0
    const retained: string[] = []
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line) continue
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      if (bytes + lineBytes > this.batchConfig.maxSpoolBytes) break
      retained.unshift(line)
      bytes += lineBytes
    }
    if (retained.length < lines.length) {
      this.counters.dropped += lines.length - retained.length
    }
    await writeFile(spoolPath, retained.length ? `${retained.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private async replaySpool(): Promise<void> {
    return this.withSpoolLock(() => this.replaySpoolUnlocked())
  }

  private async replaySpoolUnlocked(): Promise<void> {
    const spoolPath = this.batchConfig.spoolPath
    if (!spoolPath) return
    const metadata = await stat(spoolPath).catch(() => undefined)
    if (!metadata || metadata.size === 0) return

    const raw = await readFile(spoolPath, 'utf8')
    const payloads = raw
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          const parsed: unknown = JSON.parse(line)
          return isOtlpPayloads(parsed) ? [parsed] : []
        } catch {
          this.counters.dropped += 1
          return []
        }
      })
    if (payloads.length === 0) {
      await writeFile(spoolPath, '', { encoding: 'utf8', mode: 0o600 })
      return
    }

    for (let index = 0; index < payloads.length; index += this.batchConfig.maxBatchSize) {
      const batch = payloads.slice(index, index + this.batchConfig.maxBatchSize)
      await this.exportWithRetry(mergeOtlpPayloads(batch))
      this.counters.exported += batch.length
    }
    await writeFile(spoolPath, '', { encoding: 'utf8', mode: 0o600 })
  }

  private async withSpoolLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.spoolOperation.then(operation, operation)
    this.spoolOperation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export class DisabledTelemetrySink implements ExecutionTelemetrySink {
  async emit(_event: RobbExecutionTelemetryEvent): Promise<void> {}
}
