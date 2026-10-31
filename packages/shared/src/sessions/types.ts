/** Persisted session types: objective, recovery, configuration and metadata. */
export type { StoredMessage } from '@craft-agent/core/types';
export type { MissionCapabilityLock, MissionOrdinarySourceBinding, MissionOrdinaryRouteLock, SessionPersistentField, ContextCompactionOutcome } from './types/capability-locks.ts';
export { SESSION_PERSISTENT_FIELDS } from './types/capability-locks.ts';
export type { ContextCompactionIssueCode, ContextCompactionAttemptState, PendingTurnRecovery } from './types/turn-recovery.ts';
export type { SessionObjectiveTerminalState, SessionObjectiveDeclaredState, SessionObjectiveOutcomeDeclaration, ActiveSessionObjective, ExternalActionAuthorizationCategory, ExternalActionAuthorization } from './types/objectives.ts';
export type { SessionStatus, BuiltInStatusId, SessionTokenUsage, SessionAppProvenance } from './types/session-provenance.ts';
export type { SessionConfig, StoredSession } from './types/session-config.ts';
export type { SessionHeader } from './types/session-header.ts';
export type { SessionMetadata, SessionDelegation } from './types/session-metadata.ts';
