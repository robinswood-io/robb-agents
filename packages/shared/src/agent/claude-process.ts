import { spawn } from 'node:child_process';
import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { protectApplicationCommand } from '@craft-agent/session-tools-core';

export function createProtectedClaudeSpawner(stderr?: Options['stderr']): NonNullable<Options['spawnClaudeCodeProcess']> {
  return options => {
    const command = protectApplicationCommand(options.command, options.args);
    const child = spawn(command.command, command.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The SDK only drains stderr for its default spawner. Preserve diagnostics
    // and prevent a full stderr pipe from hanging a custom protected process.
    child.stderr.on('data', data => stderr?.(data.toString()));
    return child;
  };
}

export function protectedClaudeQuery(args: Parameters<typeof sdkQuery>[0]): ReturnType<typeof sdkQuery> {
  return sdkQuery({ ...args, options: {
    ...args.options,
    spawnClaudeCodeProcess: createProtectedClaudeSpawner(args.options?.stderr),
  } });
}
