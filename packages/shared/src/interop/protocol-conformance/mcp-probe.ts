import type { McpTasksConformanceInput } from './legacy-mcp.ts';
import { runLegacyMcpTasksConformance } from './legacy-mcp.ts';
import { negotiateMcpEra } from './mcp-negotiation.ts';
import { runModernMcpTasksConformance } from './modern-mcp.ts';
import type { InteropConformanceCheck, InteropConformanceReport } from './probe-types.ts';
import { check, endpointUrl, report } from './probe-types.ts';

export async function runMcpTasksConformance(
  input: McpTasksConformanceInput,
): Promise<InteropConformanceReport> {
  const endpoint = endpointUrl(input.endpoint).toString()
  const timeoutMs = input.timeoutMs ?? 15_000
  const requestedEra = input.era ?? 'auto'
  if (requestedEra === 'legacy') {
    return runLegacyMcpTasksConformance(input, endpoint, timeoutMs)
  }
  if (requestedEra === 'modern') {
    return runModernMcpTasksConformance(input, endpoint, timeoutMs)
  }
  try {
    const negotiatedEra = await negotiateMcpEra(input, endpoint, timeoutMs)
    return negotiatedEra === 'modern'
      ? runModernMcpTasksConformance(input, endpoint, timeoutMs)
      : runLegacyMcpTasksConformance(input, endpoint, timeoutMs)
  } catch (error) {
    const checks: InteropConformanceCheck[] = []
    check(
      checks,
      'version negotiation',
      false,
      error instanceof Error ? error.message : String(error),
    )
    return report('mcp-tasks', endpoint, checks)
  }
}
