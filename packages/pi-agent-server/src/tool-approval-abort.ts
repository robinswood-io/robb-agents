export interface ToolApprovalResponse {
  action: 'allow' | 'block' | 'modify';
  input?: Record<string, unknown>;
  reason?: string;
}
export interface PendingToolApproval {
  resolve: (response: ToolApprovalResponse) => void;
}

/** Stop only tools still waiting for permission; their effects have not begun. */
export async function abortSessionWithPendingApprovals(
  session: { abort(): Promise<void> } | null,
  pending: Map<string, PendingToolApproval>,
): Promise<void> {
  for (const request of pending.values()) request.resolve({ action: 'block', reason: 'Aborted' });
  pending.clear();
  await session?.abort();
}
