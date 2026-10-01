#!/usr/bin/env bun
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { constants, readFileSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalConfinementRoot,
  openConfinedRegularFile,
  readMissionEvents,
  verifyProofPassport,
  type SignedProofPassport,
} from '@craft-agent/shared/missions';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const USAGE = `Usage:
  bun run passport:verify <proof-passport.json> [--identity] --trusted-public-key <issuer-public-key.pem|issuer-public-key.der> [--workspace-root <path>]
  bun run passport:verify <proof-passport.json> [--identity] --trusted-spki <base64url-spki> [--workspace-root <path>]
  bun run passport:verify <proof-passport.json> --integrity-only [--workspace-root <path>]

Identity verification is the default and requires an Ed25519 trust anchor
provisioned outside the passport. The passport's embedded public key is never
trusted automatically. --integrity-only verifies tampering only; it does not
authenticate the signer. --workspace-root additionally rehashes the canonical
mission journal and every workspace:/// evidence artifact without following
paths outside the workspace.`;

type VerificationMode = 'identity' | 'integrity-only';

interface CliOptions {
  input: string;
  mode: VerificationMode;
  trustedPublicKeyPath?: string;
  trustedSpki?: string;
  workspaceRoot?: string;
}

export interface ProofPassportWorkspaceRevalidation {
  journalVerified: true;
  workspaceEvidenceVerified: number;
  nonWorkspaceEvidenceSkipped: number;
}

class UsageError extends Error {}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new UsageError(`${option} requires a value`);
  }
  return value;
}

export function parseProofPassportCliArguments(argv: string[]): CliOptions | { help: true } {
  let input: string | undefined;
  let mode: VerificationMode = 'identity';
  let explicitMode: VerificationMode | undefined;
  let trustedPublicKeyPath: string | undefined;
  let trustedSpki: string | undefined;
  let workspaceRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--identity' || argument === '--integrity-only') {
      const requestedMode: VerificationMode = argument === '--identity' ? 'identity' : 'integrity-only';
      if (explicitMode && explicitMode !== requestedMode) {
        throw new UsageError('--identity and --integrity-only are mutually exclusive');
      }
      explicitMode = requestedMode;
      mode = requestedMode;
      continue;
    }
    if (argument === '--trusted-public-key') {
      if (trustedPublicKeyPath !== undefined) {
        throw new UsageError('--trusted-public-key may be specified only once');
      }
      trustedPublicKeyPath = optionValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--trusted-spki') {
      if (trustedSpki !== undefined) {
        throw new UsageError('--trusted-spki may be specified only once');
      }
      trustedSpki = optionValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--workspace-root') {
      if (workspaceRoot !== undefined) {
        throw new UsageError('--workspace-root may be specified only once');
      }
      workspaceRoot = optionValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new UsageError(`Unknown option: ${argument}`);
    if (input !== undefined) throw new UsageError('Only one Proof Passport path may be supplied');
    input = argument;
  }

  if (!input) throw new UsageError('A Proof Passport path is required');
  if (mode === 'integrity-only') {
    if (trustedPublicKeyPath !== undefined || trustedSpki !== undefined) {
      throw new UsageError('Trust anchors cannot be combined with --integrity-only');
    }
  } else {
    const trustAnchorCount = Number(trustedPublicKeyPath !== undefined) + Number(trustedSpki !== undefined);
    if (trustAnchorCount === 0) {
      throw new UsageError(
        'Identity verification requires an external trust anchor: '
        + '--trusted-public-key <file> or --trusted-spki <base64url-spki>',
      );
    }
    if (trustAnchorCount > 1) {
      throw new UsageError('--trusted-public-key and --trusted-spki are mutually exclusive');
    }
  }

  return { input, mode, trustedPublicKeyPath, trustedSpki, workspaceRoot };
}

function canonicalEd25519Spki(publicKey: KeyObject): string {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Trusted Proof Passport public key must be Ed25519');
  }
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
}

function trustedSpkiFromBase64Url(value: string): string {
  if (!BASE64URL.test(value)) throw new Error('Trusted Proof Passport SPKI is not valid base64url');
  try {
    return canonicalEd25519Spki(createPublicKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'spki',
    }));
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be Ed25519')) throw error;
    throw new Error('Trusted Proof Passport SPKI is invalid');
  }
}

function trustedSpkiFromPublicKeyFile(path: string): string {
  const keyBytes = readFileSync(resolve(path));
  const keyText = keyBytes.toString('utf8').trim();
  if (keyText.includes('PRIVATE KEY')) {
    throw new Error('Trusted Proof Passport key file must contain a public key, not a private key');
  }
  try {
    const publicKey = keyText.startsWith('-----BEGIN')
      ? createPublicKey(keyText)
      : createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
    return canonicalEd25519Spki(publicKey);
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be Ed25519')) throw error;
    throw new Error('Trusted Proof Passport public key is invalid');
  }
}

function resolveTrustedSpki(options: CliOptions): string | undefined {
  if (options.mode === 'integrity-only') return undefined;
  if (options.trustedSpki !== undefined) return trustedSpkiFromBase64Url(options.trustedSpki);
  return trustedSpkiFromPublicKeyFile(options.trustedPublicKeyPath!);
}

const MAX_WORKSPACE_EVIDENCE_BYTES = 512 * 1024 * 1024;

function workspaceEvidencePath(workspaceRoot: string, uri: string): string | null {
  if (!uri.startsWith('workspace:')) return null;
  if (!uri.startsWith('workspace:///')) {
    throw new Error(`Workspace evidence URI must use the workspace:/// form: ${uri}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Workspace evidence URI is invalid: ${uri}`);
  }
  if (
    parsed.protocol !== 'workspace:'
    || parsed.host
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Workspace evidence URI is not a confined workspace locator: ${uri}`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    throw new Error(`Workspace evidence URI encoding is invalid: ${uri}`);
  }
  if (!pathname) throw new Error('Workspace evidence URI must identify a file');
  return resolve(workspaceRoot, pathname);
}

function hashWorkspaceEvidence(
  workspaceRoot: string,
  evidence: SignedProofPassport['evidence'][number],
): boolean {
  const path = workspaceEvidencePath(workspaceRoot, evidence.uri);
  if (path === null) {
    if (evidence.provenance === 'workspace-file') {
      throw new Error(
        `Workspace-file evidence "${evidence.requirementId}" does not have a workspace:/// locator`,
      );
    }
    return false;
  }
  const handle = openConfinedRegularFile(workspaceRoot, path, { flags: constants.O_RDONLY });
  try {
    const before = handle.assertStillBound();
    if (before.size > MAX_WORKSPACE_EVIDENCE_BYTES) {
      throw new Error(`Workspace evidence "${evidence.requirementId}" exceeds the verifier size limit`);
    }
    if (before.size !== evidence.sizeBytes) {
      throw new Error(`Workspace evidence "${evidence.requirementId}" size does not match the passport`);
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
      offset !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Workspace evidence "${evidence.requirementId}" changed while it was read`);
    }
    if (hash.digest('hex') !== evidence.sha256) {
      throw new Error(`Workspace evidence "${evidence.requirementId}" SHA-256 does not match the passport`);
    }
    return true;
  } finally {
    handle.close();
  }
}

/** Revalidate local artifacts only after the passport envelope has been authenticated. */
export function revalidateProofPassportWorkspace(
  passport: SignedProofPassport,
  workspaceRootInput: string,
): ProofPassportWorkspaceRevalidation {
  const workspaceRoot = canonicalConfinementRoot(resolve(workspaceRootInput));
  const journal = readMissionEvents(workspaceRoot, passport.missionId);
  if (journal.length === 0) {
    throw new Error(`Mission journal for "${passport.missionId}" does not exist or is empty`);
  }
  const journalSha256 = createHash('sha256').update(JSON.stringify(journal)).digest('hex');
  if (journalSha256 !== passport.missionJournalSha256) {
    throw new Error(`Mission journal for "${passport.missionId}" SHA-256 does not match the passport`);
  }

  let workspaceEvidenceVerified = 0;
  for (const evidence of passport.evidence) {
    if (hashWorkspaceEvidence(workspaceRoot, evidence)) workspaceEvidenceVerified += 1;
  }
  return {
    journalVerified: true,
    workspaceEvidenceVerified,
    nonWorkspaceEvidenceSkipped: passport.evidence.length - workspaceEvidenceVerified,
  };
}

export function runProofPassportCli(argv: string[]): number {
  try {
    const options = parseProofPassportCliArguments(argv);
    if ('help' in options) {
      console.log(USAGE);
      return 0;
    }
    const trustedSpki = resolveTrustedSpki(options);
    const path = resolve(options.input);
    const decision = verifyProofPassport(JSON.parse(readFileSync(path, 'utf8')), trustedSpki);
    if (!decision.valid) {
      console.error(`INVALID: ${decision.reason}`);
      return 1;
    }
    const workspaceRevalidation = options.workspaceRoot
      ? revalidateProofPassportWorkspace(decision.passport, options.workspaceRoot)
      : undefined;
    if (options.mode === 'integrity-only') {
      console.error('WARNING: integrity-only verification does not authenticate signer identity.');
    }
    console.log(JSON.stringify({
      valid: true,
      verificationMode: options.mode,
      identityVerified: options.mode === 'identity',
      passportId: decision.passport.passportId,
      missionId: decision.passport.missionId,
      outcome: decision.passport.outcome,
      evidenceCount: decision.passport.evidence.length,
      issuedAt: decision.passport.issuedAt,
      ...(workspaceRevalidation && { workspaceRevalidation }),
    }, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      console.error(`ERROR: ${message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`INVALID: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runProofPassportCli(process.argv.slice(2));
}
