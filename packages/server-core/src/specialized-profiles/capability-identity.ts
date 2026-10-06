import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SpecializedMissionProfileSelectionError } from '@craft-agent/shared/specialized-profiles';
import {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  loadSkillBySlug,
  type LoadedSkill,
} from '@craft-agent/shared/skills';
import {
  getSourceCredentialManager,
  loadWorkspaceSources,
  type LoadedSource,
} from '@craft-agent/shared/sources';
import type { CredentialId, StoredCredential } from '@craft-agent/shared/credentials';
import { getWorkspaceSkillsPath } from '@craft-agent/shared/workspaces';

export function stableCapabilityJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableCapabilityJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableCapabilityJson(record[key])}`).join(',')}}`;
}

export function specializedCapabilityIdentity(value: unknown): string {
  return createHash('sha256').update(stableCapabilityJson(value)).digest('hex');
}

function expectedSkillRoot(input: {
  workspaceRoot: string;
  workingDirectory?: string;
}, skill: LoadedSkill): string {
  if (skill.source === 'project') {
    if (!input.workingDirectory) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized skill "${skill.slug}" resolved from a project without a Mission working directory`,
      );
    }
    return resolve(input.workingDirectory, PROJECT_AGENT_SKILLS_DIR);
  }
  if (skill.source === 'workspace') return resolve(getWorkspaceSkillsPath(input.workspaceRoot));
  return resolve(GLOBAL_AGENT_SKILLS_DIR);
}

interface ReadSkillPackageFile {
  path: string;
  sha256: string;
  size: number;
  bytes: Buffer;
}

function readSkillPackageFiles(directory: string, expectedSkillsRoot: string): ReadSkillPackageFile[] {
  const lexicalDirectory = resolve(directory);
  const lexicalExpected = resolve(expectedSkillsRoot);
  const rootStat = lstatSync(lexicalDirectory);
  const skillsRootStat = lstatSync(lexicalExpected);
  if (rootStat.isSymbolicLink() || skillsRootStat.isSymbolicLink()) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized skill package "${directory}" crosses a symbolic-link boundary`,
    );
  }
  const root = realpathSync(directory);
  const expectedRoot = realpathSync(expectedSkillsRoot);
  const packageRelativePath = relative(expectedRoot, root).split('\\').join('/');
  if (!packageRelativePath
    || packageRelativePath.startsWith('../')
    || packageRelativePath.includes('/')
    || resolve(expectedRoot, packageRelativePath) !== root) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized skill package "${directory}" escaped its selected skill root`,
    );
  }
  const files: ReadSkillPackageFile[] = [];
  let totalBytes = 0;
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new SpecializedMissionProfileSelectionError(
          `Specialized skill package "${directory}" contains a symbolic link`,
        );
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.nlink > 1) {
        throw new SpecializedMissionProfileSelectionError(
          `Specialized skill package "${directory}" contains a hard-linked file`,
        );
      }
      if (files.length >= 1_000 || totalBytes + stat.size > 25 * 1024 * 1024) {
        throw new SpecializedMissionProfileSelectionError(
          `Specialized skill package "${directory}" exceeds the attestable package boundary`,
        );
      }
      const bytes = readFileSync(path);
      totalBytes += bytes.length;
      files.push({
        path: relative(root, path).split('\\').join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        bytes,
      });
    }
  };
  visit(root);
  if (!files.some(({ path }) => path === 'SKILL.md')) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized skill package "${directory}" has no SKILL.md`,
    );
  }
  return files;
}

function skillPackageIdentity(directory: string, expectedSkillsRoot: string): string {
  return specializedCapabilityIdentity(readSkillPackageFiles(directory, expectedSkillsRoot)
    .map(({ bytes: _bytes, ...file }) => file));
}

export interface SpecializedSkillPackageSnapshot {
  slug: string;
  name: string;
  /** Complete, host-sealed text package injected without a later filesystem read. */
  content: string;
  identitySha256: string;
}

export function loadSpecializedSkillPackageSnapshot(input: {
  workspaceRoot: string;
  workingDirectory?: string;
  slug: string;
}): SpecializedSkillPackageSnapshot | null {
  const skill = loadSkillBySlug(input.workspaceRoot, input.slug, input.workingDirectory);
  if (!skill) return null;
  const files = readSkillPackageFiles(skill.path, expectedSkillRoot(input, skill));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 512 * 1024) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized skill package "${skill.slug}" is too large for an immutable runtime snapshot`,
    );
  }
  const rendered = files.map((file) => {
    const text = file.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(file.bytes)) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized skill package "${skill.slug}" contains non-text runtime material`,
      );
    }
    return `--- file: ${file.path} ---\n${text}`;
  }).join('\n\n');
  const packageSha256 = specializedCapabilityIdentity(files
    .map(({ bytes: _bytes, ...file }) => file));
  return {
    slug: skill.slug,
    name: skill.metadata.name,
    content: rendered,
    identitySha256: specializedCapabilityIdentity({
      slug: skill.slug,
      source: skill.source,
      packageSha256,
    }),
  };
}

export function resolveSpecializedSkillCapabilityIdentity(input: {
  workspaceRoot: string;
  workingDirectory?: string;
  slug: string;
}): string | null {
  const skill = loadSkillBySlug(input.workspaceRoot, input.slug, input.workingDirectory);
  if (!skill) return null;
  return specializedCapabilityIdentity({
    slug: skill.slug,
    source: skill.source,
    packageSha256: skillPackageIdentity(skill.path, expectedSkillRoot(input, skill)),
  });
}

function sourceNeedsBoundCredential(source: LoadedSource): boolean {
  if (source.config.type === 'local') return false;
  if (source.config.type === 'mcp') {
    return source.config.mcp?.transport !== 'stdio'
      && source.config.mcp?.authType !== 'none';
  }
  return source.config.api?.authType !== 'none';
}

/** Hash the exact already-loaded source and credential generation consumed by a runtime. */
export function specializedSourceCapabilityBindingFromSnapshot(
  source: LoadedSource,
  bound: { credential: StoredCredential; credentialId: CredentialId } | null,
): { identitySha256: string; authorityBindingId?: string } {
  let authority: unknown = { kind: 'uncredentialed' };
  let bindingId: string | undefined;
  if (sourceNeedsBoundCredential(source)) {
    bindingId = bound?.credential.bindingId;
    if (!bindingId || !bound) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized source "${source.config.slug}" has no host-attestable credential identity`,
      );
    }
    authority = {
      kind: 'credential',
      bindingId,
      slot: {
        type: bound.credentialId.type,
        workspaceId: bound.credentialId.workspaceId ?? null,
        sourceId: bound.credentialId.sourceId ?? null,
      },
    };
  }
  return {
    identitySha256: specializedCapabilityIdentity({
      workspaceId: source.workspaceId,
      isBuiltin: source.isBuiltin ?? false,
      config: source.config,
      guide: source.guide,
      authority,
    }),
    ...(bindingId ? { authorityBindingId: bindingId } : {}),
  };
}

export async function resolveSpecializedSourceCapabilityBinding(input: {
  workspaceRoot: string;
  slug: string;
}): Promise<{ identitySha256: string; authorityBindingId?: string } | null> {
  const source = loadWorkspaceSources(input.workspaceRoot)
    .find(({ config }) => config.enabled && config.slug === input.slug);
  if (!source) return null;
  const bound = await getSourceCredentialManager().loadWithIdentity(source);
  return specializedSourceCapabilityBindingFromSnapshot(source, bound);
}

export async function resolveSpecializedSourceCapabilityIdentity(input: {
  workspaceRoot: string;
  slug: string;
}): Promise<string | null> {
  return (await resolveSpecializedSourceCapabilityBinding(input))?.identitySha256 ?? null;
}
