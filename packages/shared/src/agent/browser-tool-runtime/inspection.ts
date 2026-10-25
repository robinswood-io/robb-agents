import type { BrowserConsoleArgs, BrowserDownloadsArgs, BrowserNetworkArgs, BrowserPaneFns, BrowserWaitArgs } from "../browser-tools.ts";
import type { BrowserCommandImage, BrowserCommandResult } from './contracts.ts';
import { boundedBrowserCommandTimeout } from './execution-timeout.ts';
import { countActionableNodes, formatBytes, formatNodeLine, formatPercent, statusBucket } from './page-summary.ts';

export async function executeSnapshotBrowserCommand(fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const snapshot = await fns.snapshot();
    const roles = new Map<string, number>();
    let focusedRef: string | null = null;
    let disabledCount = 0;
    for (const node of snapshot.nodes) {
      roles.set(node.role, (roles.get(node.role) ?? 0) + 1);
      if (node.focused && !focusedRef) focusedRef = node.ref;
      if (node.disabled) disabledCount += 1;
    }

    const roleSummary = Array.from(roles.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([role, count]) => `${role}:${count}`)
      .join(', ');

    const lines: string[] = [
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      `Elements: ${snapshot.nodes.length}${roleSummary ? ` (${roleSummary})` : ''}`,
      `Focused ref: ${focusedRef ?? 'none'}, disabled: ${disabledCount}`,
      '',
      `Elements (${snapshot.nodes.length}):`,
    ];
    for (const node of snapshot.nodes) {
      lines.push(formatNodeLine(node));
    }

    const actionableCount = countActionableNodes(snapshot.nodes);
    const nearEmpty = snapshot.nodes.length === 0 || actionableCount <= 2;

    if (nearEmpty) {
      // Check if sparse/empty snapshot is caused by a security challenge
      const challenge = await fns.detectChallenge();
      if (challenge.detected) {
        await fns.releaseControl();

        // Auto-take screenshot for visual confirmation
        let screenshotImage: BrowserCommandImage | undefined;
        try {
          const screenshotResult = await fns.screenshot({ format: 'jpeg' });
          const buf = screenshotResult.imageBuffer;
          if (buf && buf.length > 0) {
            screenshotImage = {
              data: buf.toString('base64'),
              mimeType: 'image/jpeg',
              sizeBytes: buf.length,
            };
          }
        } catch {
          // Screenshot failure shouldn't block the challenge warning
        }

        const challengeLines = [
          `Security verification detected (${challenge.provider}).`,
          `Signals: ${challenge.signals.join(', ')}`,
          `URL: ${snapshot.url}`,
          '',
          `Detected only ${actionableCount} actionable element(s) out of ${snapshot.nodes.length} accessibility nodes.`,
          'This is consistent with a security challenge page blocking normal interaction.',
          'Browser shown — please complete the verification check.',
          'After verification, run "resume 120000"; it will wait without blocking your clicks.',
        ];

        return {
          output: challengeLines.join('\n'),
          appendReleaseHint: false,
          image: screenshotImage,
        };
      }

      if (snapshot.nodes.length === 0) {
        lines.push('');
        lines.push('No accessibility elements were detected on this view.');
        lines.push('This can happen on canvas-heavy/custom UIs. Try: evaluate <js>, click-at <x> <y>, type <text>, screenshot --annotated.');
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeFindBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const query = parts.slice(1).join(' ').trim();
    if (!query) throw new Error('find requires a search query. Example: find login button');

    const snapshot = await fns.snapshot();
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(Boolean);

    const scored = snapshot.nodes
      .map((node) => {
        const haystack = [node.role, node.name, node.value, node.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!keywords.every((kw) => haystack.includes(kw))) return null;
        let score = 0;
        for (const kw of keywords) {
          if ((node.name ?? '').toLowerCase().includes(kw)) score += 3;
          if ((node.role ?? '').toLowerCase().includes(kw)) score += 2;
          if ((node.value ?? '').toLowerCase().includes(kw)) score += 1;
          if ((node.description ?? '').toLowerCase().includes(kw)) score += 1;
        }
        return { node, score };
      })
      .filter((x): x is { node: typeof snapshot.nodes[number]; score: number } => !!x)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        output: `No elements found matching "${query}" (searched ${snapshot.nodes.length} elements).\nTry a broader search or run "snapshot" to see all elements.`,
        appendReleaseHint: true,
      };
    }

    const lines: string[] = [
      `Found ${scored.length} element(s) matching "${query}" from ${snapshot.nodes.length} scanned elements:`,
    ];
    for (const { node, score } of scored.slice(0, 20)) {
      lines.push(`${formatNodeLine(node, { includeState: false })} (score=${score})`);
    }
    if (scored.length > 20) {
      lines.push(`  ... and ${scored.length - 20} more. Narrow your search.`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeConsoleBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const limitRaw = parts[1];
    const levelRaw = parts[2];
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limitRaw && Number.isNaN(limit)) {
      throw new Error(`Invalid console limit "${limitRaw}". Expected a number.`);
    }
    const level = (levelRaw ?? 'all') as NonNullable<BrowserConsoleArgs['level']>;
    if (!['all', 'log', 'info', 'warn', 'error'].includes(level)) {
      throw new Error(`Invalid console level "${String(levelRaw)}". Use one of: all, log, info, warn, error.`);
    }

    const entries = await fns.getConsoleLogs({ limit, level });
    const levelCounts = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.level] = (acc[entry.level] ?? 0) + 1;
      return acc;
    }, {});

    const lines: string[] = [
      `Console entries (${entries.length}) for level=${level}: log=${levelCounts.log ?? 0}, info=${levelCounts.info ?? 0}, warn=${levelCounts.warn ?? 0}, error=${levelCounts.error ?? 0}`,
    ];

    if (entries.length > 0) {
      lines.push(`Range: ${new Date(entries[0]!.timestamp).toISOString()} → ${new Date(entries[entries.length - 1]!.timestamp).toISOString()}`);
    }

    for (const entry of entries) {
      lines.push(`[${new Date(entry.timestamp).toISOString()}] [${entry.level}] ${entry.message}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeNetworkBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const limitRaw = parts[1];
    const statusRaw = parts[2] as BrowserNetworkArgs['status'] | undefined;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limitRaw && Number.isNaN(limit)) {
      throw new Error(`Invalid network limit "${limitRaw}". Expected a number.`);
    }
    const status = statusRaw ?? 'all';
    if (!['all', 'failed', '2xx', '3xx', '4xx', '5xx'].includes(status)) {
      throw new Error(`Invalid network status "${String(statusRaw)}". Use one of: all, failed, 2xx, 3xx, 4xx, 5xx.`);
    }
    const entries = await fns.getNetworkLogs({ limit, status });
    const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
    const hostCounts = new Map<string, number>();

    for (const entry of entries) {
      buckets[statusBucket(entry.status)] += 1;
      try {
        const host = new URL(entry.url).hostname;
        hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
      } catch {
        // ignore malformed urls
      }
    }

    const failed = buckets['4xx'] + buckets['5xx'] + buckets.other;
    const topHosts = Array.from(hostCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([host, count]) => `${host}(${count})`)
      .join(', ');

    const lines: string[] = [
      `Network entries (${entries.length}) for status=${status}: 2xx=${buckets['2xx']} 3xx=${buckets['3xx']} 4xx=${buckets['4xx']} 5xx=${buckets['5xx']} other=${buckets.other}`,
      `Failed ratio: ${formatPercent(failed, entries.length || 1)}${topHosts ? `, top hosts: ${topHosts}` : ''}`,
    ];

    for (const entry of entries) {
      lines.push(`[${new Date(entry.timestamp).toISOString()}] ${entry.method} ${entry.status} ${entry.resourceType} ${entry.url}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeWaitBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const kind = parts[1] as BrowserWaitArgs['kind'] | undefined;
    if (!kind || !['selector', 'text', 'url', 'network-idle'].includes(kind)) {
      throw new Error('wait requires kind: selector|text|url|network-idle');
    }

    let value: string | undefined;
    let timeoutMs: number | undefined;
    if (kind === 'network-idle') {
      const timeoutRaw = parts[2];
      timeoutMs = timeoutRaw ? boundedBrowserCommandTimeout(timeoutRaw, 'wait') : undefined;
    } else {
      value = parts[2];
      if (!value) throw new Error(`wait ${kind} requires a value.`);
      const timeoutRaw = parts[3];
      timeoutMs = timeoutRaw ? boundedBrowserCommandTimeout(timeoutRaw, 'wait') : undefined;
    }

    const started = Date.now();
    const result = await fns.waitFor({ kind, value, timeoutMs });
    const totalElapsed = Date.now() - started;

    return {
      output: [
        `Wait succeeded (${result.kind}) in ${result.elapsedMs}ms — ${result.detail}`,
        `Configured timeout: ${timeoutMs ?? 'default'}, wall time: ${totalElapsed}ms`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

export async function executeDownloadsBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const actionRaw = parts[1] as BrowserDownloadsArgs['action'] | undefined;
    const action = actionRaw && ['list', 'wait'].includes(actionRaw) ? actionRaw : 'list';
    const valueRaw = parts[2];
    const valueNum = valueRaw
      ? action === 'wait'
        ? boundedBrowserCommandTimeout(valueRaw, 'downloads wait')
        : Number(valueRaw)
      : undefined;
    if (valueRaw && action !== 'wait' && !Number.isFinite(valueNum)) {
      throw new Error(`Invalid downloads numeric value "${valueRaw}". Expected a finite number.`);
    }

    const entries = await fns.getDownloads({
      action,
      ...(action === 'wait' ? { timeoutMs: valueNum } : { limit: valueNum }),
    });

    const states = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.state] = (acc[entry.state] ?? 0) + 1;
      return acc;
    }, {});

    const lines: string[] = [
      `Downloads (${entries.length}) action=${action}: started=${states.started ?? 0}, completed=${states.completed ?? 0}, interrupted=${states.interrupted ?? 0}, cancelled=${states.cancelled ?? 0}`,
    ];

    for (const entry of entries) {
      const savePathSuffix = entry.savePath ? ` -> ${entry.savePath}` : '';
      lines.push(
        `[${new Date(entry.timestamp).toISOString()}] [${entry.state}] ${entry.filename} (${formatBytes(entry.bytesReceived)}/${formatBytes(entry.totalBytes)})${savePathSuffix}`,
      );
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

export async function executeEvaluateBrowserCommand(parts: string[], fns: BrowserPaneFns): Promise<BrowserCommandResult> {
    const expression = parts.slice(1).join(' ').trim();
    if (!expression) throw new Error('evaluate requires an expression. Example: evaluate document.title');
    const result = await fns.evaluate(expression);
    const type = Array.isArray(result) ? 'array' : (result === null ? 'null' : typeof result);

    let rendered: string;
    if (typeof result === 'string') {
      rendered = result;
    } else {
      try {
        rendered = JSON.stringify(result, null, 2);
      } catch {
        rendered = String(result);
      }
    }

    const wasTruncated = rendered.length > 6000;
    if (wasTruncated) {
      rendered = `${rendered.slice(0, 6000)}\n... (truncated)`;
    }

    return {
      output: [`Evaluate result type: ${type}`, rendered].join('\n'),
      appendReleaseHint: true,
    };
  }
