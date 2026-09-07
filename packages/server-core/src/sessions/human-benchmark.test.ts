import { describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { evaluateHumanBenchmark, type HumanBenchmark } from './human-benchmark.ts';
import { evaluateAutonomyAcceptance } from './autonomy-acceptance.ts';

// Fabricated unit-test fixtures only; these are never empirical evaluation data.
const keys = generateKeyPairSync('ed25519');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(): HumanBenchmark {
  const artifact = (name: string) => ({ path: name, sha256: sha(name) });
  const score = (participantId: string, quality: number, artifactName: string) => ({ participantId, quality, elapsedSeconds: 20, costUsd: 1, artifact: artifact(artifactName) });
  return { protocol: { id: 'unit-fixture', registeredAt: '2026-01-01T00:00:00Z', synthetic: false, domains: ['development'], rubric: artifact('rubric'), blinded: true, professionalHumans: true, trainingFamilyIds: ['training1'], timeBudgetSeconds: 60, maxAgentCostUsd: 3 },
    cases: Array.from({ length: 30 }, (_, i) => ({ id: `case${i}`, familyId: `family${i}`, domain: 'development', startedAt: '2026-02-01T00:00:00Z', input: artifact(`input${i}`), agent: score('agent', 95, `agent${i}`), humans: [score('h1', 70, `h1${i}`), score('h2', 80, `h2${i}`), score('h3', 90, `h3${i}`)], objectiveComplete: true, unauthorizedActions: 0, falseCompletion: false, manualContinuations: 0 })), signature: '' };
}
function evaluate(data = fixture(), artifacts = true) {
  data.signature = sign(null, Buffer.from(JSON.stringify({ protocol: data.protocol, cases: data.cases })), keys.privateKey).toString('base64');
  return evaluateHumanBenchmark(data, { reviewerPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), verifyArtifact: () => artifacts });
}
describe('independent human benchmark — E14 E16', () => {
  it('evaluates quality, latency and cost separately with a family-level confidence bound', () => {
    const report = evaluate(); expect(report.eligible).toBe(true);
    expect(report.domains[0]?.winRateLower95).toBeGreaterThan(0.8);
    expect(report.domains[0]?.meanQualityDelta).toBe(5);
    expect(report.domains[0]?.meanTimeRatio).toBe(1);
    expect(report.domains[0]?.meanCostDeltaUsd).toBe(0);
  });
  it('rejects missing signatures/artifacts and cannot qualify a synthetic or small sample', () => {
    expect(evaluateHumanBenchmark(fixture()).eligible).toBe(false);
    expect(evaluate(fixture(), false).eligible).toBe(false);
    const synthetic = fixture(); synthetic.protocol.synthetic = true; expect(evaluate(synthetic).eligible).toBe(false);
    const small = fixture(); small.cases = small.cases.slice(0, 1); expect(evaluate(small).eligible).toBe(false);
    const tie = fixture(); tie.cases.forEach(c => c.agent.quality = 90); expect(evaluate(tie).eligible).toBe(false);
  });
  it('rejects leakage, duplicates, late protocols, missing independent raters, and unsafe successes', () => {
    const mutations: Array<(data: HumanBenchmark) => void> = [
      d => { d.cases[0]!.familyId = 'training1'; }, d => { d.cases[1]!.familyId = d.cases[0]!.familyId; },
      d => { d.protocol.registeredAt = '2026-03-01T00:00:00Z'; }, d => { d.protocol.blinded = false; },
      d => { d.cases[0]!.humans[0]!.participantId = 'agent'; }, d => { d.cases[0]!.unauthorizedActions = 1; },
      d => { d.cases[0]!.falseCompletion = true; }, d => { d.cases[0]!.manualContinuations = 1; },
      d => { d.cases[0]!.agent.costUsd = 4; }, d => { d.cases[0]!.agent.elapsedSeconds = 61; },
    ];
    for (const mutate of mutations) { const data = fixture(); mutate(data); expect(evaluate(data).eligible).toBe(false); }
  });
  it('detects tampering after signing and makes the final promotion gate depend on qualification', () => {
    const data = fixture(); evaluate(data); data.cases[0]!.agent.quality = 100;
    expect(evaluateHumanBenchmark(data, { reviewerPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), verifyArtifact: () => true }).eligible).toBe(false);
    const observations = fixture().cases.map(c => ({ scenarioId: c.id, eligible: true, objectiveRetained: true, manualContinuations: 0, declaredComplete: true, groundTruthComplete: true, mutations: [], humanBenchmark: { domain: c.domain, agentScore: 95, humanTopQuartileScore: 90 } }));
    expect(evaluateAutonomyAcceptance(observations).eligibleForPromotion).toBe(false);
    expect(evaluateAutonomyAcceptance(observations, undefined, evaluate()).eligibleForPromotion).toBe(true);
  });
});
