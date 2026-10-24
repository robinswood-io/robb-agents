
// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function out(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n')
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}

export function err(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`)
}

// ---------------------------------------------------------------------------
// ANSI colors (disabled when NO_COLOR is set or stdout is not a TTY)
// ---------------------------------------------------------------------------

export const _useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false

export const c = {
  dim: (s: string) => _useColor ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => _useColor ? `\x1b[32m${s}\x1b[39m` : s,
  red: (s: string) => _useColor ? `\x1b[31m${s}\x1b[39m` : s,
  cyan: (s: string) => _useColor ? `\x1b[36m${s}\x1b[39m` : s,
  bold: (s: string) => _useColor ? `\x1b[1m${s}\x1b[22m` : s,
  yellow: (s: string) => _useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s: string) => _useColor ? `\x1b[34m${s}\x1b[39m` : s,
}

// ---------------------------------------------------------------------------
// Spinner (TTY only — skipped when piped or NO_COLOR)
// ---------------------------------------------------------------------------

const _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function createSpinner(text: string): { stop(): void } {
  let i = 0
  let stopped = false
  // Render first frame immediately — setInterval alone misses fast steps
  process.stdout.write(`${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  }, 80)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
    },
  }
}
