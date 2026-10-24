/**
 * Project Memory v2
 *
 * Local-first, append-only structured memory for a project. MEMORY.md remains
 * supported as a human-editable legacy source; this journal adds machine
 * readable provenance, temporal validity, confidence, lifecycle, and retrieval.
 */
import { realpathSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";
import type { MemoryJournalEvent, MemoryRetrievalWeights, ProjectMemoryEntry } from './memory-schema.ts';
import { DEFAULT_RETRIEVAL_WEIGHTS, clamp01, isRecord } from './memory-schema.ts';

export function deriveRelationshipStatuses(
  entries: ProjectMemoryEntry[],
  now: Date,
): ProjectMemoryEntry[] {
  const statusById = new Map(entries.map((entry) => [entry.id, entry.status]));
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  for (const entry of entries) {
    if (!isMemoryRelationEffective(entry, now)) continue;
    for (const id of entry.supersedesIds) {
      if (entry.scope?.version && entriesById.get(id)?.scope?.version !== entry.scope.version) continue;
      if (statusById.get(id) === 'active') statusById.set(id, 'superseded');
    }
    for (const id of entry.contradictsIds) {
      if (entry.scope?.version && entriesById.get(id)?.scope?.version !== entry.scope.version) continue;
      const current = statusById.get(id);
      if (current === 'active' || current === 'superseded') {
        statusById.set(id, 'contradicted');
      }
    }
  }
  return entries.map((entry) => ({
    ...entry,
    status: statusById.get(entry.id) ?? entry.status,
  }));
}

function isMemoryRelationEffective(entry: ProjectMemoryEntry, now: Date): boolean {
  const nowMs = now.getTime();
  if (entry.status === 'forgotten' || entry.status === 'proposed') return false;
  if (Date.parse(entry.validFrom) > nowMs) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) <= nowMs) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) return false;
  return true;
}

export function isMemoryEntryRetrievable(entry: ProjectMemoryEntry, now: Date): boolean {
  const nowMs = now.getTime();
  if (entry.status !== 'active') return false;
  if (Date.parse(entry.validFrom) > nowMs) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) <= nowMs) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) return false;
  return true;
}

export function lexicalScore(entry: ProjectMemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0.5;
  const documentTokens = memorySearchFeatures(`${entry.tags.join(' ')} ${entry.content}`).tokens;
  if (documentTokens.length === 0) return 0;
  const documentCounts = new Map<string, number>();
  for (const token of documentTokens) {
    documentCounts.set(token, (documentCounts.get(token) ?? 0) + 1);
  }
  const uniqueQuery = [...new Set(queryTokens)];
  const matched = uniqueQuery.filter((token) => documentCounts.has(token));
  const coverage = matched.length / uniqueQuery.length;
  const frequency = matched.reduce(
    (total, token) => total + Math.min(3, documentCounts.get(token) ?? 0),
    0,
  ) / (uniqueQuery.length * 3);
  return clamp01(coverage * 0.8 + frequency * 0.2);
}

export function tokenize(value: string): string[] {
  return value
    .slice(0, 16_384)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{Letter}\p{Number}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
    .slice(0, 512);
}

// Retrieval hints only: these groups never generate a fact, instruction or
// proposal. Unknown words retain exact lexical matching. No network/model call.
const SEARCH_STOP_WORDS = new Set('the a an and or to of in on for from with is are was were be been this that these those it its as at by de des du la le les un une et ou au aux dans pour par sur avec est sont ce cet cette ces il elle ils elles qui que nous vous je tu mon ma mes ton ta tes notre votre pas ne'.split(' '));

const SEARCH_CONCEPT_GROUPS = [
  ['account', 'accounts', 'compte', 'comptes'],
  ['alternate', 'alternative', 'secondary', 'secondaire', 'secondaires', 'autre', 'autres', 'alternatif'],
  ['authentication', 'authenticate', 'login', 'signin', 'connexion', 'connecter', 'authentification', 'authentifier'],
  ['access', 'acces', 'permission', 'permissions', 'autorisation', 'autorisations'],
  ['document', 'documents', 'pdf', 'rapport', 'report'],
  ['render', 'rendering', 'rendu', 'visual', 'visuel', 'visuelle'],
  ['verify', 'verification', 'verifier', 'verifie', 'check', 'checks', 'control', 'controle', 'controler'],
  ['test', 'tests', 'testing', 'essai', 'essais', 'tester'],
  ['deploy', 'deployment', 'deploiement', 'deployer', 'deploye', 'publier', 'publish', 'publication'],
  ['failure', 'failed', 'error', 'errors', 'echec', 'echoue', 'erreur', 'erreurs'],
  ['correct', 'corrected', 'fix', 'fixed', 'correction', 'corriger', 'corrige', 'reparer'],
  ['evidence', 'proof', 'receipt', 'preuve', 'preuves', 'recu', 'recus'],
  ['database', 'db', 'bdd', 'donnees'],
  ['email', 'mail', 'courriel', 'notification', 'notifications'],
  ['missing', 'absent', 'absente', 'manquant', 'manquante', 'manque', 'omission'],
  ['attachment', 'attachments', 'piece', 'pieces', 'jointe', 'jointes'],
  ['browser', 'navigateur', 'navigation'],
  ['runtime', 'execution', 'executer', 'execute'],
  ['expired', 'expiry', 'expiration', 'expire', 'perime', 'perimee'],
  ['certificate', 'certificat', 'certificats'],
] as const;

const SEARCH_CONCEPTS = new Map<string, string>(SEARCH_CONCEPT_GROUPS.flatMap(group => group.map(word => [word, group[0]] as [string, string])));

interface MemorySearchFeatures { tokens: string[]; concepts: Set<string> }

const searchFeatureCache = new Map<string, MemorySearchFeatures>();

const SEARCH_FEATURE_CACHE_LIMIT = 512;

export function memorySearchFeatures(text: string): MemorySearchFeatures {
  // Content-addressing invalidates edited entries immediately, including edits
  // made by another process. Time/status/scope checks stay outside this cache.
  const key = createHash('sha256').update(text).digest('hex');
  const cached = searchFeatureCache.get(key);
  if (cached) { searchFeatureCache.delete(key); searchFeatureCache.set(key, cached); return cached; }
  const tokens = tokenize(text);
  const value = { tokens, concepts: new Set(tokens.map(token => SEARCH_CONCEPTS.get(token) ?? token)) };
  if (searchFeatureCache.size >= SEARCH_FEATURE_CACHE_LIMIT) searchFeatureCache.delete(searchFeatureCache.keys().next().value!);
  searchFeatureCache.set(key, value);
  return value;
}

export function conceptSimilarity(query: MemorySearchFeatures, document: MemorySearchFeatures): number {
  if (!query.concepts.size || !document.concepts.size) return 0;
  const matches = [...query.concepts].filter(concept => document.concepts.has(concept)).length;
  // Require two shared anchors for a semantic-only match: a single broad word
  // such as "verify" must not import an unrelated procedure into context.
  if (matches < 2) return 0;
  const coverage = matches / query.concepts.size;
  const cosine = matches / Math.sqrt(query.concepts.size * document.concepts.size);
  return 0.6 * coverage + 0.4 * cosine;
}

export function normalizeMemoryScope(value: unknown): { projectSlug: string; workspaceKey?: string; version?: string } {
  if (!isRecord(value) || typeof value.projectSlug !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.projectSlug)) throw new Error('Invalid memory project scope');
  if (value.version !== undefined && (typeof value.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.version))) throw new Error('Invalid memory version scope');
  if (value.workspaceKey !== undefined && (typeof value.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.workspaceKey))) throw new Error('Invalid memory workspace scope');
  return { projectSlug: value.projectSlug, ...(typeof value.workspaceKey === 'string' ? { workspaceKey: value.workspaceKey } : {}), ...(typeof value.version === 'string' ? { version: value.version } : {}) };
}

export function memoryWorkspaceIdentity(root: string, legacyWorkspaceRootPath?: string): {
  canonicalKey: string;
  acceptedKeys: ReadonlySet<string>;
} {
  const resolvedRoot = resolve(root);
  let physicalRoot = resolvedRoot;
  try {
    physicalRoot = realpathSync.native(resolvedRoot);
  } catch {
    // Project creation may ask for a key before the workspace exists. Retain
    // the prior deterministic pathname behavior until it can be canonicalized.
  }
  const canonicalKey = createHash('sha256').update(physicalRoot).digest('hex');
  const lexicalKey = createHash('sha256').update(resolvedRoot).digest('hex');
  const legacyLexicalKey = legacyWorkspaceRootPath
    ? createHash('sha256').update(resolve(legacyWorkspaceRootPath)).digest('hex')
    : undefined;
  return {
    canonicalKey,
    acceptedKeys: new Set([canonicalKey, lexicalKey, legacyLexicalKey].filter(
      (key): key is string => typeof key === 'string',
    )),
  };
}

export function memoryWorkspaceKey(root: string): string { return memoryWorkspaceIdentity(root).canonicalKey; }

export function quoteMemoryMetadata(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function normalizeWeights(
  partial: Partial<MemoryRetrievalWeights> | undefined,
  hasVectorScores: boolean,
): MemoryRetrievalWeights {
  const configured = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...partial };
  const effective = {
    ...configured,
    vector: hasVectorScores ? configured.vector : 0,
    lexical: hasVectorScores
      ? configured.lexical
      : configured.lexical + configured.vector,
  };
  for (const [name, weight] of Object.entries(effective)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Memory retrieval weight ${name} must be finite and non-negative`);
    }
  }
  const total = effective.lexical + effective.recency + effective.confidence + effective.vector;
  if (total <= 0) throw new Error('At least one memory retrieval weight must be positive');
  return {
    lexical: effective.lexical / total,
    recency: effective.recency / total,
    confidence: effective.confidence / total,
    vector: effective.vector / total,
  };
}

export function checksumPayload(payload: MemoryJournalEvent): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
