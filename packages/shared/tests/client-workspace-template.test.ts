import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoutingPolicy, validateRoutingPolicy, type RoutingPolicy } from '../src/config/routing-policy.ts';
import type { LlmConnection } from '../src/config/llm-connections.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const templateDir = join(repoRoot, 'docs', 'robinswood', 'templates', 'client-workspace');

function loadPolicy(name: string): RoutingPolicy {
  return JSON.parse(readFileSync(join(templateDir, name), 'utf-8')) as RoutingPolicy;
}

function connection(slug: string, providerType: LlmConnection['providerType']): Pick<LlmConnection, 'slug' | 'providerType'> {
  return { slug, providerType };
}

const standardConnections = [
  connection('local-rapide', 'pi_compat'),
  connection('souverain-standard', 'pi_compat'),
  connection('premium-analyse-complexe', 'anthropic'),
  connection('google-gemini', 'pi'),
  connection('openrouter-experimentation', 'pi_compat'),
];

describe('Robinswood client workspace routing policy templates', () => {
  it('validates the standard template and keeps restricted local-only', () => {
    const policy = loadPolicy('routing-policy.standard.json');
    const validation = validateRoutingPolicy(policy, standardConnections.map(item => item.slug));
    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual([]);

    const restricted = resolveRoutingPolicy(policy, standardConnections, { sensitivity: 'restricted' });
    expect(restricted.selectedConnectionSlug).toBe('local-rapide');
    expect(restricted.allowedConnectionSlugs).toEqual(['local-rapide']);
    expect(restricted.fallbackConnectionSlugs).toEqual([]);
  });

  it('allows premium/Gemini only for public content in the standard template', () => {
    const policy = loadPolicy('routing-policy.standard.json');
    const publicDecision = resolveRoutingPolicy(policy, standardConnections, { sensitivity: 'public' });
    expect(publicDecision.allowedConnectionSlugs).toContain('google-gemini');
    expect(publicDecision.allowedConnectionSlugs).toContain('premium-analyse-complexe');

    const internal = resolveRoutingPolicy(policy, standardConnections, { sensitivity: 'internal' });
    expect(internal.allowedConnectionSlugs).not.toContain('google-gemini');
    expect(internal.allowedConnectionSlugs).not.toContain('premium-analyse-complexe');
  });

  it('validates the no-external-premium template and denies external premium everywhere', () => {
    const policy = loadPolicy('routing-policy.no-external-premium.json');
    const validation = validateRoutingPolicy(policy, standardConnections.map(item => item.slug));
    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual([]);

    for (const sensitivity of ['public', 'internal', 'confidential', 'restricted'] as const) {
      const decision = resolveRoutingPolicy(policy, standardConnections, { sensitivity });
      expect(decision.allowedConnectionSlugs).not.toContain('google-gemini');
      expect(decision.allowedConnectionSlugs).not.toContain('premium-analyse-complexe');
      expect(decision.allowedConnectionSlugs).not.toContain('openrouter-experimentation');
    }
  });
});
