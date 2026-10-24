
export interface SourceTestArgs {
  sourceSlug: string;
  /**
   * Auto-enable the source on success (flip `enabled: true` if needed
   * and activate it in the running session).
   * Defaults to `true`. Pass `false` for pure validation behavior.
   */
  autoEnable?: boolean;
}

/**
 * Test result structure for API/MCP connection tests
 */
interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  needsAuth?: boolean;
  error?: string;
}
