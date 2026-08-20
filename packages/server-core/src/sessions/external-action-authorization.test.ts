import { describe, expect, it } from 'bun:test';
import {
  hasMatchingExternalActionAuthorization,
  providerAlwaysAllowForExternalAction,
  pruneExternalActionAuthorizations,
  rememberExternalActionAuthorization,
} from './external-action-authorization.ts';

describe('external action authorization grants', () => {
  it('persists and matches only the same category and concrete target', () => {
    const grants = rememberExternalActionAuthorization([], {
      category: 'external_send',
      targetCandidates: ['Louise@example.com'],
      toolName: 'gmail_send',
    }, 100, 1_000);

    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['louise@example.com'],
    }, 500)).toBe(true);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'external_send',
      targetCandidates: ['other@example.com'],
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'payment',
      targetCandidates: ['louise@example.com'],
    }, 500)).toBe(false);
  });

  it('never creates a broad grant without a concrete target', () => {
    expect(rememberExternalActionAuthorization([], {
      category: 'deployment',
      targetCandidates: [],
      toolName: 'deploy',
    }, 100)).toEqual([]);
  });

  it('requires the complete canonical target set instead of any overlapping target', () => {
    const grants = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin main'],
      toolName: 'Bash',
    }, 100, 1_000);

    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['ORIGIN MAIN', 'déploy@prod.example'],
    }, 500)).toBe(true);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin release'],
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['deploy@staging.example', 'origin main'],
    }, 500)).toBe(false);
    expect(hasMatchingExternalActionAuthorization(grants, {
      category: 'git_push',
      targetCandidates: ['origin main'],
    }, 500)).toBe(false);
  });

  it('keeps distinct overlapping scopes instead of replacing either grant', () => {
    const first = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin main'],
      toolName: 'Bash',
    }, 100, 1_000);
    const second = rememberExternalActionAuthorization(first, {
      category: 'git_push',
      targetCandidates: ['deploy@prod.example', 'origin release'],
      toolName: 'Bash',
    }, 200, 1_000);

    expect(second).toHaveLength(2);
  });

  it('expires grants and replaces an older grant for the same scope', () => {
    const first = rememberExternalActionAuthorization([], {
      category: 'git_push',
      targetCandidates: ['origin/main'],
      toolName: 'Bash',
    }, 100, 100);
    expect(pruneExternalActionAuthorizations(first, 201)).toEqual([]);

    const renewed = rememberExternalActionAuthorization(first, {
      category: 'git_push',
      targetCandidates: ['origin/main'],
      toolName: 'Bash',
    }, 150, 500);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.grantedAt).toBe(150);
  });

  it('never forwards a broad provider whitelist for an exact sensitive grant', () => {
    expect(providerAlwaysAllowForExternalAction(true, 'git_push')).toBe(false);
    expect(providerAlwaysAllowForExternalAction(true, 'external_send')).toBe(false);
    expect(providerAlwaysAllowForExternalAction(true)).toBe(true);
    expect(providerAlwaysAllowForExternalAction(false, 'git_push')).toBe(false);
  });
});
