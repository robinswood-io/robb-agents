/**
 * Tests for auth state management
 *
 * These tests verify:
 * - Token refresh returns migration info through function chain (no module-level state)
 * - Setup needs derivation from auth state
 * - Migration detection for legacy CLI tokens
 */
import { describe, it, expect } from 'bun:test';
import { getSetupNeeds, type AuthState, type MigrationInfo } from '../state.ts';

describe('getSetupNeeds', () => {
  describe('billing configuration', () => {
    it('should need billing config when type is null', () => {
      const state: AuthState = {
        billing: {
          type: null,
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(true);
      expect(needs.needsCredentials).toBe(false);
      expect(needs.isFullyConfigured).toBe(false);
    });

    it('should not need billing config when type is set', () => {
      const state: AuthState = {
        billing: {
          type: 'api_key',
          hasCredentials: true,
          apiKey: 'sk-test',
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(false);
    });
  });

  describe('credentials', () => {
    it('should need credentials when type is set but hasCredentials is false', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(false);
      expect(needs.needsCredentials).toBe(true);
      expect(needs.isFullyConfigured).toBe(false);
    });

    it('should not need credentials when hasCredentials is true', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: true,
          apiKey: null,
          claudeOAuthToken: 'valid-token',
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsCredentials).toBe(false);
      expect(needs.isFullyConfigured).toBe(true);
    });
  });

  describe('migration', () => {
    it('should propagate migration info from auth state', () => {
      const migrationInfo: MigrationInfo = {
        reason: 'legacy_token',
        message: 'Please re-authenticate',
      };

      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
          migrationRequired: migrationInfo,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsMigration).toEqual(migrationInfo);
      expect(needs.needsMigration?.reason).toBe('legacy_token');
    });

    it('should not have migration info when not present in auth state', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: true,
          apiKey: null,
          claudeOAuthToken: 'valid-token',
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsMigration).toBeUndefined();
    });
  });

  describe('fully configured', () => {
    it('should be fully configured when billing type and credentials are set', () => {
      const state: AuthState = {
        billing: {
          type: 'api_key',
          hasCredentials: true,
          apiKey: 'sk-test',
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: true, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.isFullyConfigured).toBe(true);
      expect(needs.needsBillingConfig).toBe(false);
      expect(needs.needsCredentials).toBe(false);
    });
  });
});
