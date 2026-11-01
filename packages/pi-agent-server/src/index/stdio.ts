import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import type { OutboundMessage } from "./contracts.ts";

// ============================================================
// JSONL I/O
// ============================================================
export function send(msg: OutboundMessage): void {
    const line = JSON.stringify(msg);
    process.stdout.write(line + '\n');
}

export function debugLog(message: string): void {
    // Write debug messages to stderr so they don't interfere with JSONL protocol
    process.stderr.write(`[pi-server] ${message}\n`);
}

/** Find the most recent .jsonl session file in a directory. */
export function findMostRecentSessionFile(sessionDir: string): string | null {
    if (!existsSync(sessionDir))
        return null;
    let best: {
        path: string;
        mtime: number;
    } | null = null;
    for (const entry of readdirSync(sessionDir)) {
        if (!entry.endsWith('.jsonl'))
            continue;
        const fullPath = join(sessionDir, entry);
        const mtime = statSync(fullPath).mtimeMs;
        if (!best || mtime > best.mtime) {
            best = { path: fullPath, mtime };
        }
    }
    return best?.path ?? null;
}
