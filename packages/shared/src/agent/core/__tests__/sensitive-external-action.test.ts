import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, hashSensitiveExternalActionOperation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { classifySensitiveExternalAction, isSensitiveExternalActionExplicitlyAuthorized } from "../sensitive-external-action.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function checkMcp(
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  currentUserRequest?: string,
  options?: {
    externalActionPolicy?: 'confirm' | 'allow-in-execute';
    objectiveMutationAuthorized?: boolean;
    objectiveSensitiveActionAuthorized?: boolean;
    objectiveAuthorizationSegments?: readonly string[];
    authenticatedUserAuthorizationSegments?: readonly string[];
    dataFolderPath?: string;
    declaredToolCapabilities?: {
      readOnly?: boolean;
      idempotent?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
      trusted?: boolean;
    };
    sessionId?: string;
  },
) {
  const markerSessionId = toolName === 'mcp__rbw-agents-oss__oss_write_file'
    ? /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu.exec(
      options?.objectiveAuthorizationSegments?.find(segment => /^\[robb-resume:/mu.test(segment))
        ?? currentUserRequest ?? '',
    )?.[1]
    : undefined;
  const sessionId = options?.sessionId ?? markerSessionId ?? `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  const sourceSlug = toolName.split('__')[1] ?? '';
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    toolUseId: `call-${randomUUID()}`,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [sourceSlug],
    allSourceSlugs: [sourceSlug],
    hasSourceActivation: false,
    ...(options?.externalActionPolicy !== undefined ? { externalActionPolicy: options?.externalActionPolicy } : {}),
    ...(options?.objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized: options?.objectiveMutationAuthorized } : {}),
    ...(options?.objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized } : {}),
    ...(options?.objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments } : {}),
    ...(options?.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments } : {}),
    ...(options?.dataFolderPath !== undefined ? { dataFolderPath: options?.dataFolderPath } : {}),
    ...(options?.declaredToolCapabilities !== undefined ? { declaredToolCapabilities: options?.declaredToolCapabilities } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
  });
}

afterEach(() => {
  setSystemTime();
  for (const sessionId of usedSessionIds.splice(0)) {
    clearContextualGmailPreflightAttestation(sessionId);
    cleanupModeState(sessionId);
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('sensitive external action classifier', () => {
  it('hashes the exact tool and semantic payload while ignoring display metadata', () => {
    const first = hashSensitiveExternalActionOperation('mcp__google-contacts__gmail_send', {
      to: 'sender@example.test',
      subject: 'Contrat Silae',
      body: 'Bonjour',
      _intent: 'Envoyer',
      nested: { b: 2, a: 1 },
    });
    const reordered = hashSensitiveExternalActionOperation('mcp__google-contacts__gmail_send', {
      nested: { a: 1, b: 2 },
      _displayName: 'Gmail',
      body: 'Bonjour',
      subject: 'Contrat Silae',
      to: 'sender@example.test',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(hashSensitiveExternalActionOperation('mcp__google-contacts__gmail_send', {
      to: 'sender@example.test', subject: 'Contrat Silae', body: 'Bonsoir', nested: { a: 1, b: 2 },
    })).not.toBe(first);
    expect(hashSensitiveExternalActionOperation('mcp__google-contacts__gmail_reply', {
      to: 'sender@example.test', subject: 'Contrat Silae', body: 'Bonjour', nested: { a: 1, b: 2 },
    })).not.toBe(first);
  });

  it('classifies the audited SSH mutations', () => {
    const push = classifySensitiveExternalAction('Bash', {
      command: "ssh deploy@prod.example 'cd /srv/app && git push origin main'",
    });
    expect(push?.category).toBe('git_push');
    expect(push?.targetCandidates).toContain('deploy@prod.example');

    const connectorPush = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'prod-server', command: 'git push origin main',
    });
    expect(connectorPush).toMatchObject({ category: 'git_push', promptType: 'mcp_mutation' });
    expect<unknown>(connectorPush?.targetCandidates).toEqual(expect.arrayContaining([
      'unresolved remote scope', 'origin main',
    ]));

    const compose = classifySensitiveExternalAction('Bash', {
      command: "ssh deploy@prod.example 'docker compose --profile prod up -d --no-deps work-prod-backend'",
    });
    expect(compose?.category).toBe('deployment');
    expect(compose?.targetCandidates).toContain('work-prod-backend');

    const secretWrite = classifySensitiveExternalAction('Bash', {
      command: `ssh deploy@prod.example "python3 - <<'PY'
from pathlib import Path
source = Path('backend/.env').read_text()
key = [line for line in source.splitlines() if line.startswith('NIGHT_AGENT_API_KEY=')][0]
prod = Path('.env.prod')
prod.write_text(key + '\\n')
PY"`,
    });
    expect(secretWrite?.category).toBe('secret_transfer');
    expect(secretWrite?.commandPreview).not.toContain('NIGHT_AGENT_API_KEY');
  });

  it('names the managed DEV worktree project without treating the shared manager as that project', () => {
    const action = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev',
      cwd: '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930',
      command: 'touch apps/web/lib/orion/campaign.ts',
    });
    expect<unknown>(action?.targetCandidates).toEqual(expect.arrayContaining(['dev', 'orion', 'unresolved remote scope']));
    expect(action?.targetCandidates).not.toContain('ia-webdev');
    const manager = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev', cwd: '/opt/ia-webdev/agent-dev', command: 'touch marker',
    });
    expect(manager?.targetCandidates).not.toContain('orion');
  });

  it('classifies generic mutating HTTP shell requests without treating transport as a send', () => {
    for (const command of [
      "curl -X POST https://api.example.com/jobs -d '{\"run\":true}'",
      'curl --json={"run":true} https://api.example.com/jobs',
      'curl -dpayload https://api.example.com/jobs',
      'curl -T/tmp/archive.zip https://api.example.com/jobs',
      'curl --form-string=note=value https://api.example.com/jobs',
      'curl --request=DELETE https://api.example.com/jobs/7',
      'wget --post-data=value https://api.example.com/jobs',
      'wget --body-file=/tmp/payload https://api.example.com/jobs',
    ]) expect(classifySensitiveExternalAction('Bash', { command })?.category).toBe('external_mutation');
    expect(classifySensitiveExternalAction('Bash', {
      command: 'curl --get --data query=status https://api.example.com/jobs',
    })).toBeNull();
  });

  it('preserves sensitive HTTP semantics before generic send or mutation handling', () => {
    expect(classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST https://api.stripe.com/v1/payment_intents -d amount=1000',
    })).toMatchObject({ category: 'payment', targetCandidates: ['api.stripe.com', '1000'] });
    expect(classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST https://api.render.com/v1/deployments -d service=zero',
    })).toMatchObject({ category: 'deployment', targetCandidates: ['api.render.com'] });
    expect(classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST https://api.render.com/v1/services/x/deploys -d x=1',
    })).toMatchObject({ category: 'deployment', targetCandidates: ['api.render.com'] });
    expect(classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST https://api.example.com/admin/restart -d service=zero',
    })).toMatchObject({ category: 'service_restart', targetCandidates: ['api.example.com'] });
    expect(classifySensitiveExternalAction('Bash', {
      command: 'stripe payment_intents create --amount 1000',
    })).toMatchObject({ category: 'payment', targetCandidates: ['stripe', '1000'] });

    const payment = classifySensitiveExternalAction('Bash', {
      command: 'curl -X POST https://api.stripe.com/v1/payment_intents -d amount=1000',
    });
    expect(payment && isSensitiveExternalActionExplicitlyAuthorized(
      payment, 'Envoie la requête à api.stripe.com.',
    )).toBeFalse();
    expect(payment && isSensitiveExternalActionExplicitlyAuthorized(
      payment, 'Effectue le paiement de 1000 sur api.stripe.com.',
    )).toBeTrue();
  });

  it('keeps remote filesystem transfers behind an explicit host prompt', () => {
    const upload = classifySensitiveExternalAction('mcp__rbw-servers__ssh_upload', {
      server: 'dev',
      localPath: '/tmp/patch.py',
      remotePath: '/srv/workspace/zero/.zero-devlogin-patch.py',
    });
    expect(upload).toMatchObject({
      category: 'external_mutation',
      targetCandidates: ['dev', 'zero', 'unresolved remote scope'],
    });

    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_upload',
      { server: 'dev', localPath: '/tmp/patch.py', remotePath: '/srv/workspace/zero/.zero-devlogin-patch.py' },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: [
          'Applique le correctif minimal strictement borné à Zero.',
          'Poursuis.',
        ],
      },
    )).toMatchObject({ type: 'block' });

    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_upload',
      { server: 'dev', localPath: '/tmp/patch.py', remotePath: '/srv/workspace/zero/.zero-devlogin-patch.py' },
      'Modifie Zero sur le serveur dev.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Modifie Zero sur le serveur dev.'],
      },
    )).toMatchObject({
      type: 'prompt',
      command: (expect.stringContaining('dev:/srv/workspace/zero/.zero-devlogin-patch.py') as unknown),
      sensitiveActionTargets: ['dev', 'zero', 'unresolved remote scope'],
      requiresExplicitConfirmation: true,
    });

    const liveZeroObjective = "Tu dois réactiver le dev login abrutit c'est ta mission";
    for (const [toolName, input] of [
      ['mcp__rbw-servers__ssh_upload', {
        server: 'dev', localPath: '/tmp/patch.py',
        remotePath: '/srv/workspace/zero/.zero-devlogin-patch.py',
      }],
      ['mcp__rbw-servers__ssh_execute', {
        server: 'dev', cwd: '/srv/workspace/zero', command: 'touch marker',
      }],
    ] as const) {
      expect(checkMcp('allow-all', toolName, input, liveZeroObjective, {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: [liveZeroObjective],
      })).toMatchObject({ type: 'block' });
    }
    for (const server of ['prod', 'evil']) {
      expect(checkMcp(
        'allow-all', 'mcp__rbw-servers__ssh_upload', {
          server, localPath: '/tmp/patch.py',
          remotePath: '/srv/workspace/zero/.zero-devlogin-patch.py',
        }, liveZeroObjective, {
          externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
          objectiveAuthorizationSegments: [liveZeroObjective],
        },
      )).toMatchObject({ type: 'block' });
    }

    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_upload',
      { server: 'dev', localPath: '/tmp/patch.py', remotePath: '/srv/workspace/other/.patch.py' },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Applique le correctif minimal strictement borné à Zero.'],
      },
    )).toMatchObject({ type: 'block' });

    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_upload', {
      server: 'dev',
      cwd: '/srv/workspace/zero',
      localPath: '/tmp/patch.py',
      remotePath: '/srv/workspace/other/payload.py',
    })).toMatchObject({ targetCandidates: ['dev', 'other', 'unresolved remote scope'] });
    expect(checkMcp(
      'allow-all', 'mcp__rbw-servers__ssh_upload',
      {
        server: 'dev', cwd: '/srv/workspace/zero', localPath: '/tmp/patch.py',
        remotePath: '/srv/workspace/other/payload.py',
      },
      'Corrige Zero.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige Zero.'],
      },
    )).toMatchObject({ type: 'block' });

    // The broader implementation vocabulary belongs only to bounded remote
    // project transports. It must never authorize an unrelated business MCP.
    expect(checkMcp(
      'allow-all', 'mcp__crm__update_record', { id: 'zero' }, 'Corrige Zero.',
      {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige Zero.'],
      },
    )).toMatchObject({ type: 'block' });

    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev', cwd: '/srv/workspace/pns-gen-worktrees/fix-edoc', command: 'touch marker',
    })).toMatchObject({ targetCandidates: ['dev', 'pns gen', 'unresolved remote scope'] });

    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev',
      cwd: '/srv/workspace/.worktrees/work-development-hierarchy-20260918',
      command: 'touch marker',
    })).toMatchObject({
      targetCandidates: ['dev', 'work-development-hierarchy-20260918', 'unresolved remote scope'],
    });
    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev',
      cwd: '/srv/workspace/.worktrees/work-development-hierarchy-sibling',
      command: 'touch marker',
    })).toMatchObject({
      targetCandidates: ['dev', 'work-development-hierarchy-sibling', 'unresolved remote scope'],
    });
    for (const cwd of [
      '/srv/workspace/.worktrees',
      '/srv/workspace/.secrets/project',
      '/srv/workspace/.ssh/project',
      '/srv/workspace/.worktrees/.git',
      '/srv/workspace/.worktrees/*',
      '/srv/workspace/.worktrees/${TARGET}',
      '/srv/workspace/.worktrees/work–development',
    ]) {
      const targets = classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
        server: 'dev', cwd, command: 'touch marker',
      })?.targetCandidates;
      expect(targets, cwd).toContain('unresolved remote scope');
      expect(targets, cwd).not.toContain('.worktrees');
      expect(targets, cwd).not.toContain('.secrets');
      expect(targets, cwd).not.toContain('.ssh');
    }
  });

  it('resolves remote execution paths and traversal before granting project authority', () => {
    const cases = [
      'cd /srv/workspace/other && touch marker',
      'cd ../other && touch marker',
      'touch /srv/workspace/other/marker',
      'printf changed > /srv/workspace/other/marker',
    ];
    for (const command of cases) {
      const input = { server: 'dev', cwd: '/srv/workspace/zero', command };
      expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', input))
        .toMatchObject({
          category: 'external_mutation',
          targetCandidates: ['dev', 'other', 'unresolved remote scope'],
        });
      expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute', input, 'Corrige Zero.', {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige Zero.'],
      })).toMatchObject({ type: 'block', reason: (expect.stringContaining('exact target') as unknown) });
      expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute', input, 'Corrige Other sur le serveur dev.', {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
        objectiveAuthorizationSegments: ['Corrige Other sur le serveur dev.'],
      })).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true });
    }

    const destructive = {
      server: 'dev', cwd: '/srv/workspace/zero', command: 'rm -rf ../other',
    };
    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', destructive))
      .toMatchObject({
        category: 'external_mutation',
        targetCandidates: ['dev', 'other', 'unresolved remote scope'],
      });
    expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute', destructive, 'Corrige Other.', {
      externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
      objectiveAuthorizationSegments: ['Corrige Other.'],
    })).toMatchObject({ type: 'block', reason: (expect.stringContaining('exact target') as unknown) });
    expect(checkMcp('allow-all', 'mcp__rbw-servers__ssh_execute', destructive, 'Supprime les fichiers Other sur le serveur dev.', {
      externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: true,
      objectiveAuthorizationSegments: ['Supprime les fichiers Other sur le serveur dev.'],
    })).toMatchObject({ type: 'prompt', requiresExplicitConfirmation: true });

    expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
      server: 'dev', cwd: '/srv/workspace/zero', command: 'touch marker && touch ../other/marker',
    })).toMatchObject({
      targetCandidates: ['dev', 'zero', 'unresolved remote scope', 'other'],
    });

    for (const command of [
      'touch /etc/passwd',
      'touch /tmp/outside',
      'touch "$TARGET"',
      'cd "$TARGET" && touch marker',
      '(cd /srv/workspace/other && touch a); touch b',
    ]) {
      expect(classifySensitiveExternalAction('mcp__rbw-servers__ssh_execute', {
        server: 'dev', cwd: '/srv/workspace/zero', command,
      })?.targetCandidates).toContain('unresolved remote scope');
    }
  });
});
