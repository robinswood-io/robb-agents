import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidSkillSlug,
  resolveSkillDir,
  loadSkill,
  skillExists,
  getSkillIconPath,
  deleteSkill,
} from '../skills/storage.ts';
import { getSourcePath } from '../sources/storage.ts';
import { getProjectPath } from '../projects/storage.ts';
import { classifyExternalUrl, isSafeExternalUrl } from '../utils/url-safety.ts';
import { SecureStorageBackend } from '../credentials/backends/secure-storage.ts';
import { OAuthFlowStore, createPendingFlow } from '../auth/oauth-flow-store.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('Shared Package Security Hardening Regressions', () => {
  describe('Slug & Path Traversal Guards', () => {
    it('rejects path traversal slugs in skills storage', () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'robb-sec-skills-'));
      try {
        for (const badSlug of ['', '.', '..', '../etc', 'foo/bar', 'foo\\bar', 'foo\0bar', '..\\secret']) {
          expect(isValidSkillSlug(tempRoot, badSlug)).toBe(false);
          expect(() => resolveSkillDir(tempRoot, badSlug)).toThrow(/Invalid skill slug/);
          expect(loadSkill(tempRoot, badSlug)).toBeNull();
          expect(skillExists(tempRoot, badSlug)).toBe(false);
          expect(getSkillIconPath(tempRoot, badSlug)).toBeNull();
          expect(() => deleteSkill(tempRoot, badSlug)).toThrow(/Invalid skill slug/);
        }
        expect(isValidSkillSlug(tempRoot, 'my-valid_skill.1')).toBe(true);
        expect(resolveSkillDir(tempRoot, 'my-valid_skill.1')).toBe(join(tempRoot, 'my-valid_skill.1'));
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('rejects path traversal slugs in sources and projects storage', () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'robb-sec-ws-'));
      try {
        for (const badSlug of ['', '.', '..', '../outside', 'nested/slug', 'nested\\slug', 'null\0byte']) {
          expect(() => getSourcePath(tempRoot, badSlug)).toThrow(/Invalid source slug/);
          expect(() => getProjectPath(tempRoot, badSlug)).toThrow(/Invalid project slug/);
        }
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('URL Classification & Dangerous Scheme Blocking', () => {
    it('recognizes craftagents:, robbagents:, and robbagentsdev: as internal deeplinks', () => {
      expect(classifyExternalUrl('craftagents://action')).toEqual({ kind: 'internal-deeplink' });
      expect(classifyExternalUrl('robbagents://action')).toEqual({ kind: 'internal-deeplink' });
      expect(classifyExternalUrl('robbagentsdev://action')).toEqual({ kind: 'internal-deeplink' });
    });

    it('blocks dangerous execution and network share schemes', () => {
      for (const dangerousUrl of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'ms-msdt:/id PCWDiagnostic',
        'search-ms:query=calc',
        'smb://evil.example.com/share',
        'dav://evil.example.com/share',
        'davs://evil.example.com/share',
      ]) {
        expect(classifyExternalUrl(dangerousUrl).kind).toBe('dangerous');
        expect(isSafeExternalUrl(dangerousUrl)).toBe(false);
      }
      expect(isSafeExternalUrl('https://example.com')).toBe(true);
    });
  });

  describe('SecureStorageBackend Filter Completeness & PBKDF2 Salt Caching', () => {
    it('filters credentials by sourceId and connectionSlug in list()', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'robb-sec-cred-'));
      try {
        const backend = new SecureStorageBackend({
          credentialsFile: join(tempDir, 'credentials.enc'),
          machineId: 'test-machine-uuid',
        });

        await backend.set(
          { type: 'source_oauth', workspaceId: 'ws1', sourceId: 'github' },
          { value: 'tok-gh' },
        );
        await backend.set(
          { type: 'source_oauth', workspaceId: 'ws1', sourceId: 'linear' },
          { value: 'tok-lin' },
        );
        await backend.set(
          { type: 'llm_api_key', connectionSlug: 'openai-main' },
          { value: 'sk-1' },
        );
        await backend.set(
          { type: 'llm_api_key', connectionSlug: 'anthropic-main' },
          { value: 'sk-2' },
        );

        const ghOnly = await backend.list({ type: 'source_oauth', workspaceId: 'ws1', sourceId: 'github' });
        expect(ghOnly).toHaveLength(1);
        expect(ghOnly[0]?.sourceId).toBe('github');

        const oaiOnly = await backend.list({ type: 'llm_api_key', connectionSlug: 'openai-main' });
        expect(oaiOnly).toHaveLength(1);
        expect(oaiOnly[0]?.connectionSlug).toBe('openai-main');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('OAuthFlowStore Bounding & Anti-Replay', () => {
    it('bounds pending flows to maxFlows and supports atomic consumeByState', () => {
      const store = new OAuthFlowStore(4);
      try {
        for (let i = 0; i < 10; i++) {
          store.store(
            createPendingFlow({
              flowId: `flow-${i}`,
              state: `state-${i}`,
              codeVerifier: 'verifier',
              redirectUri: 'https://127.0.0.1/callback',
              source: {} as any,
              clientId: 'client-1',
              tokenEndpoint: 'https://auth.example.com/token',
              provider: 'mcp' as any,
              ownerClientId: 'ws-client-1',
              workspaceId: 'ws-1',
              sourceSlug: 'src-1',
            }),
          );
        }
        expect(store.size).toBe(4);
        expect(store.getByState('state-0')).toBeNull();
        expect(store.getByState('state-9')?.flowId).toBe('flow-9');

        // One-shot consumeByState prevents state replay
        const consumed = store.consumeByState('state-9');
        expect(consumed?.flowId).toBe('flow-9');
        expect(store.consumeByState('state-9')).toBeNull();
      } finally {
        store.dispose();
      }
    });
  });

  describe('Hardened sprintf-js (GHSA-hp3w-g68c-fv3c Precision/Width Bounds)', () => {
    it('formats normal specifiers and rejects excessive precision/width DoS specifiers', () => {
      const { sprintf } = require('../../../../scripts/vendor/sprintf-js/src/sprintf.js');
      expect(sprintf('%04d %.2f %s', 7, 3.14159, 'ok')).toBe('0007 3.14 ok');
      expect(() => sprintf('%5000s', 'dos')).toThrow(RangeError);
      expect(() => sprintf('%.5000s', 'dos')).toThrow(RangeError);
      expect(() => sprintf('%.500f', 1.23)).toThrow(RangeError);
    });
  });
});
