import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicy,
  type RoutingSensitivity,
} from '../src/config/routing-policy.ts';
import type { LlmConnection } from '../src/config/llm-connections.ts';

const root = join(import.meta.dir, '..', '..', '..');
const examplePath = join(root, 'docs', 'robinswood', 'routing-policy.example.json');
const policy = JSON.parse(readFileSync(examplePath, 'utf8')) as RoutingPolicy;

const connections: Array<Pick<LlmConnection, 'slug' | 'providerType'>> = [
  { slug: 'local-rapide', providerType: 'pi_compat' },
  { slug: 'souverain-standard', providerType: 'pi_compat' },
  { slug: 'premium-analyse-complexe', providerType: 'anthropic' },
  { slug: 'openrouter-experimentation', providerType: 'pi' },
];

describe('Robinswood routing-policy.example.json', () => {
  it('is valid against the routing policy helper', () => {
    const result = validateRoutingPolicy(policy, connections.map(connection => connection.slug));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['restricted', 'local-rapide'],
    ['confidential', 'souverain-standard'],
    ['internal', 'souverain-standard'],
    ['public', 'premium-analyse-complexe'],
  ] as Array<[RoutingSensitivity, string]>)('selects %s route policy-first', (sensitivity, expectedSlug) => {
    const decision = resolveRoutingPolicy(policy, connections, { sensitivity });

    expect(decision.errors).toEqual([]);
    expect(decision.selectedConnectionSlug).toBe(expectedSlug);
    expect(decision.reason).toBe('rule-preference');
  });

  it('still honors the global deny list after a permissive public rule', () => {
    const decision = resolveRoutingPolicy(policy, connections, { sensitivity: 'public' });

    expect(decision.allowedConnectionSlugs).not.toContain('openrouter-experimentation');
    expect(decision.selectedConnectionSlug).toBe('premium-analyse-complexe');
  });
});
