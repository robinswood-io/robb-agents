import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cleanupModeState, setPermissionMode } from '../../mode-manager.ts';
import {
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../pre-tool-use.ts';

const liveSessions: string[] = [];

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => true,
};

afterEach(() => {
  for (const sessionId of liveSessions.splice(0)) cleanupModeState(sessionId);
});

describe.skipIf(process.platform !== 'darwin')('pre-tool-use application protection', () => {
  it('blocks direct installed-bundle writes even in Execute mode and with a whitelist', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const sessionId = `application-protection-${randomUUID()}`;
      liveSessions.push(sessionId);
      setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });

      const result = runPreToolUseChecks({
        toolName,
        input: {
          [toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path']:
            '/Applications/Robb Agents.app/Contents/Resources/app.asar',
        },
        sessionId,
        permissionMode: 'allow-all',
        workspaceRootPath: '/tmp/application-protection-workspace',
        workspaceId: 'application-protection-workspace',
        activeSourceSlugs: [],
        allSourceSlugs: [],
        hasSourceActivation: false,
        permissionManager,
      });

      expect(result).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('installed Robb Agents'),
      });
    }
  });
});
