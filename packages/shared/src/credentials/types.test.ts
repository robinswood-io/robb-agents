import { describe, expect, it } from 'bun:test';
import { accountToCredentialId, credentialIdToAccount } from './types.ts';

describe('credential identifiers', () => {
  it('keeps every scoped credential in an explicit namespace', () => {
    expect(credentialIdToAccount({ type: 'anthropic_api_key' })).toBe('anthropic_api_key::global');
    expect(credentialIdToAccount({ type: 'llm_oauth', connectionSlug: 'primary' })).toBe('llm_oauth::primary');
    expect(credentialIdToAccount({ type: 'workspace_oauth', workspaceId: 'workspace-a' })).toBe('workspace_oauth::workspace-a');
    expect(credentialIdToAccount({
      type: 'source_bearer',
      workspaceId: 'workspace-a',
      sourceId: 'crm',
    })).toBe('source_bearer::workspace-a::crm');
    expect(credentialIdToAccount({
      type: 'governance_signing_key',
      workspaceId: 'workspace-a',
      name: 'execution-proof-v1',
    })).toBe('governance_signing_key::workspace-a::execution-proof-v1');
    expect(accountToCredentialId('governance_signing_key::workspace-a::execution-proof-v1')).toEqual({
      type: 'governance_signing_key',
      workspaceId: 'workspace-a',
      name: 'execution-proof-v1',
    });
  });

  it('fails closed instead of collapsing an incomplete scope to global', () => {
    expect(() => credentialIdToAccount({ type: 'llm_api_key' })).toThrow('connectionSlug is required');
    expect(() => credentialIdToAccount({ type: 'workspace_oauth' })).toThrow('workspaceId is required');
    expect(() => credentialIdToAccount({ type: 'source_oauth', workspaceId: 'workspace-a' })).toThrow('sourceId is required');
    expect(() => credentialIdToAccount({ type: 'governance_signing_key', workspaceId: 'workspace-a' })).toThrow('name is required');
    expect(() => credentialIdToAccount({
      type: 'messaging_bearer',
      workspaceId: 'workspace-a',
      name: 'telegram::admin',
    })).toThrow('must not contain');
  });

  it('rejects malformed persisted account keys', () => {
    expect(accountToCredentialId('source_bearer::workspace-a::')).toBeNull();
    expect(accountToCredentialId('llm_oauth::')).toBeNull();
    expect(accountToCredentialId('unknown::global')).toBeNull();
  });
});
