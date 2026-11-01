import { describe, expect, it } from "bun:test";
import { isObjectiveShellExecutorToolName } from "../registered-observation.ts";

describe('objective shell executor tool names', () => {
  it.each([
    'Bash', 'bash', 'functions.bash', 'shell', 'functions.shell',
    'exec_command', 'functions.exec_command', 'mcp__ops__exec_command',
    'ssh_execute', 'mcp__ops__ssh_execute', 'vendor:remote:ssh_execute',
  ])('recognizes a native or namespaced executor suffix: %s', toolName => {
    expect(isObjectiveShellExecutorToolName(toolName)).toBe(true);
  });

  it.each([
    '', 'notbash', 'mcp__ops__bash_status', 'mcp__ops__ssh_execute_status',
    'mcp__ops__run_command', 'mcp__ops__shellcheck', 'browser_tool',
  ])('does not infer shell execution from a partial token: %s', toolName => {
    expect(isObjectiveShellExecutorToolName(toolName)).toBe(false);
  });
});
