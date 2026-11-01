/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export type { AgentInteropProtocol, AgentInteropPermission, AgentTaskStatus, AgentInteropIdentity, AgentTaskCreateInput, AgentTaskSnapshot, AgentTaskEvent, AgentTaskService, AgentInteropAdapterConfig, AgentInteropAuditEvent, McpTaskRequest, A2AAgentCard, AgUiEvent, AgentInteropConfiguration } from './agent-interop/contracts.ts';
export { AgentInteropError } from './agent-interop/contracts.ts';
export { AgentInteropAuditLog } from './agent-interop/adapter-base.ts';
export { McpTasksAdapter, A2AAdapter, AgUiAdapter, createAgentInteropAdapters } from './agent-interop/protocol-adapters.ts';
