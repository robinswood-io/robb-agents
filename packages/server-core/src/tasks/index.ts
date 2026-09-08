/**
 * @craft-agent/server-core/tasks
 *
 * The Conductor — the in-process DAG runner for Tasks. Builds on the spec,
 * validation, and storage primitives in @craft-agent/shared/tasks and the
 * SessionManager completion/output seams.
 */
export { TaskRunner, DEFAULT_AUTONOMOUS_RETRY_POLICY } from './TaskRunner';
export {
  inferTaskNodeProfile,
  resolveTaskModelSettings,
  taskNodeSpecialistPreamble,
} from './task-node-execution';
export { loadWorkspaceExecutionProofIssuer } from './execution-proof-runtime';
export type {
  ConductorSessionHost,
  TaskRunnerDeps,
  RunOptions,
  RunSnapshot,
  RunStatus,
  NodeRunStatus,
  TaskExecutionGuardContext,
  TaskFailureClass,
  TaskRetryPolicy,
} from './TaskRunner';
export type {
  TaskNodeSpecialty,
  TaskNodeProfile,
  TaskModelSettings,
} from './task-node-execution';
export type { GovernanceCredentialStore } from './execution-proof-runtime';
