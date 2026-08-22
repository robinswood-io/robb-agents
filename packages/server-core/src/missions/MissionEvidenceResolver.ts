import { createHash } from 'node:crypto';
import {
  constants,
  readSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  WorkSubmissionSchema,
  canonicalConfinementRoot,
  openConfinedRegularFile,
  type MissionWorkItem,
  type ConfinedRegularFile,
  type ResolvedMissionEvidence,
  type WorkSubmission,
} from '@craft-agent/shared/missions';

const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface ResolvedMissionSubmission {
  submission: WorkSubmission;
  evidence: ResolvedMissionEvidence[];
}

function workspacePath(workspaceRoot: string, uri: string): string {
  if (uri.startsWith('workspace:')) {
    const parsed = new URL(uri);
    if (parsed.host || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      throw new Error('Workspace evidence URI cannot contain an authority, query, or fragment');
    }
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    if (!pathname) throw new Error('Workspace evidence URI must identify a file');
    return resolve(workspaceRoot, pathname);
  }
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  if (URI_SCHEME.test(uri)) {
    throw new Error(`Evidence URI scheme is not host-resolvable: ${uri.split(':', 1)[0]}`);
  }
  return isAbsolute(uri) ? uri : resolve(workspaceRoot, uri);
}

function hashFile(handle: ConfinedRegularFile, expectedSha256?: string): { sha256: string; sizeBytes: number } {
  const before = handle.assertStillBound();
  if (before.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`Mission evidence exceeds the ${MAX_EVIDENCE_BYTES} byte host limit`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const read = readSync(
      handle.descriptor,
      buffer,
      0,
      Math.min(buffer.length, before.size - offset),
      offset,
    );
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  const after = handle.assertStillBound();
  if (
    offset !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error('Mission evidence changed while it was being read');
  }
  const sha256 = hash.digest('hex');
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new Error('Mission evidence SHA-256 does not match the host-observed file');
  }
  return { sha256, sizeBytes: before.size };
}

function portableWorkspaceUri(workspaceRoot: string, resolvedPath: string): string {
  const path = relative(workspaceRoot, resolvedPath).split(sep).map(encodeURIComponent).join('/');
  return `workspace:///${path}`;
}

/**
 * Resolves every submitted evidence reference at the host boundary. A model-authored
 * URI is never considered proof until this function has opened and hashed the file.
 */
export function resolveMissionSubmissionEvidence(input: {
  workspaceRoot: string;
  item: MissionWorkItem;
  submission: WorkSubmission;
  observedAt?: string;
}): ResolvedMissionSubmission {
  const submission = WorkSubmissionSchema.parse(input.submission);
  const workspaceRoot = canonicalConfinementRoot(input.workspaceRoot);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const requirements = new Map(input.item.requiredEvidence.map((requirement) => [requirement.id, requirement]));
  const seen = new Set<string>();
  const resolvedEvidence: ResolvedMissionEvidence[] = [];
  const normalizedEvidence = submission.evidence.map((evidence) => {
    if (seen.has(evidence.requirementId)) {
      throw new Error(`Evidence requirement "${evidence.requirementId}" was supplied more than once`);
    }
    seen.add(evidence.requirementId);
    const requirement = requirements.get(evidence.requirementId);
    if (requirement?.kind && requirement.kind !== evidence.kind) {
      throw new Error(`Evidence kind for "${evidence.requirementId}" must be ${requirement.kind}`);
    }
    let handle: ConfinedRegularFile;
    try {
      handle = openConfinedRegularFile(workspaceRoot, workspacePath(workspaceRoot, evidence.uri), {
        flags: constants.O_RDONLY,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Evidence "${evidence.requirementId}" escapes the workspace boundary or cannot be resolved safely: ${reason}`,
      );
    }
    let observed: { sha256: string; sizeBytes: number };
    let uri: string;
    try {
      observed = hashFile(handle, evidence.sha256);
      uri = portableWorkspaceUri(workspaceRoot, handle.path);
    } finally {
      handle.close();
    }
    resolvedEvidence.push({
      workItemId: input.item.id,
      requirementId: evidence.requirementId,
      kind: evidence.kind,
      uri,
      ...observed,
      observedAt,
      provenance: 'workspace-file',
    });
    return { ...evidence, uri, sha256: observed.sha256 };
  });
  const missing = [...requirements.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Missing required evidence: ${missing.join(', ')}`);
  return {
    submission: WorkSubmissionSchema.parse({ ...submission, evidence: normalizedEvidence }),
    evidence: resolvedEvidence,
  };
}
