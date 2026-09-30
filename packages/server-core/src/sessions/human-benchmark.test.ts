import { describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateHumanBenchmark, humanBenchmarkSignedPayload, type HumanBenchmark } from './human-benchmark.ts';
import { evaluateAutonomyAcceptance, type AutonomyAcceptanceObservation } from './autonomy-acceptance.ts';

// Fabricated, isolated unit-test fixtures. synthetic:false exercises the real-data gate;
// it is never an assertion of real human participation. Never export these as measurements.
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(): HumanBenchmark {
  const artifact = (name: string) => ({ path: name, sha256: sha(name) });
  const score = (participantId: string, quality: number, artifactName: string) => ({
    participantId, quality, elapsedSeconds: participantId === 'agent' ? 20 : 40,
    costUsd: 1, artifact: artifact(artifactName), supervisionSeconds: 0, supervisionCostUsd: 0, automaticRetries: 0,
  });
  const protocol: HumanBenchmark['protocol'] = {
    id: 'fabricated-unit-fixture', registeredAt: '2026-01-01T00:00:00Z', synthetic: false,
    domains: ['development'], rubric: artifact('rubric'), blinded: true, professionalHumans: true,
    trainingFamilyIds: ['training1'], timeBudgetSeconds: 60, maxAgentCostUsd: 3,
    speedQualification: { humanBaseline: 'median-professional-human', elapsedDefinition: 'start-to-verified-outcome', costDefinition: 'total-including-supervision' },
    provenance: { buildCommit: 'a'.repeat(40), build: artifact('build'), configuration: artifact('configuration') },
  };
  return { protocol, cases: Array.from({ length: 30 }, (_, i) => ({
    id: `case${i}`, familyId: `family${i}`, domain: 'development', startedAt: '2026-02-01T00:00:00Z', input: artifact(`input${i}`),
    agent: score('agent', 95, `agent${i}`), humans: [score('h1', 70, `h1${i}`), score('h2', 80, `h2${i}`), score('h3', 90, `h3${i}`)],
    objectiveComplete: true, unauthorizedActions: 0, falseCompletion: false, manualContinuations: 0,
    run: { runId: `run${i}`, protocolId: protocol.id, buildCommit: protocol.provenance!.buildCommit,
      buildSha256: protocol.provenance!.build.sha256, configurationSha256: protocol.provenance!.configuration.sha256 },
  })), signature: '' };
}
function signFixture(data: HumanBenchmark): void {
  data.signature = sign(null, Buffer.from(humanBenchmarkSignedPayload(data)), keys.privateKey).toString('base64');
}
function evaluate(data = fixture(), artifacts = true) {
  signFixture(data);
  return evaluateHumanBenchmark(data, { reviewerPublicKey: publicKey, verifyArtifact: () => artifacts });
}
function observations(data: HumanBenchmark): AutonomyAcceptanceObservation[] {
  return data.cases.map(c => ({ scenarioId: c.id, eligible: true, objectiveRetained: true,
    manualContinuations: c.manualContinuations, declaredComplete: c.objectiveComplete, groundTruthComplete: c.objectiveComplete,
    mutations: [], humanBenchmark: { domain: c.domain, agentScore: c.agent.quality, humanTopQuartileScore: 90 }, benchmarkRun: c.run,
  }));
}

describe('independent human benchmark — joint quality and execution speed', () => {
  it('qualifies a complete preregistered protocol with family-level uncertainty and observable metrics', () => {
    const data = fixture();
    data.cases.forEach((c, i) => { c.agent.elapsedSeconds = i + 1; c.agent.automaticRetries = 1; c.agent.supervisionSeconds = 2; c.agent.supervisionCostUsd = 0.25; });
    const report = evaluate(data), domain = report.domains[0]!;
    expect(report.eligible).toBe(true);
    expect(report.qualityAndSpeedQualified).toBe(true);
    expect(report.maxTimeRatio).toBe(1);
    expect(domain.winRateLower95).toBeCloseTo(0.8864866, 6);
    expect(domain.jointWinRateLower95).toBeCloseTo(0.8864866, 6);
    expect(domain.meanQualityDelta).toBe(5);
    expect(domain.timeRatio).toEqual({ median: 15.5 / 40, p95: 29 / 40 });
    // For n=30, exact binomial tails select order statistics 10 and 21.
    expect(domain.medianTimeRatio95).toEqual({ lower: 10 / 40, upper: 21 / 40 });
    expect(domain.agentElapsedSeconds).toEqual({ median: 15.5, p95: 29 });
    expect(domain.humanBaselineElapsedSeconds).toEqual({ median: 40, p95: 40 });
    expect(domain.meanCostDeltaUsd).toBe(0);
    expect(domain.totalAgentCostUsd).toBe(30);
    expect(domain.totalHumanCostUsd).toBe(90);
    expect(domain.totalAgentSupervisionSeconds).toBe(60);
    expect(domain.totalAgentSupervisionCostUsd).toBe(7.5);
    expect(domain.totalAgentAutomaticRetries).toBe(30);
  });

  it('rejects the previously accepted agent that is twenty times slower despite superior quality', () => {
    const data = fixture(); data.protocol.timeBudgetSeconds = 600;
    data.cases.forEach(c => { c.agent.elapsedSeconds = 200; c.humans.forEach(h => h.elapsedSeconds = 10); });
    const report = evaluate(data);
    expect(report.eligible).toBe(false);
    expect(report.domains[0]?.wins).toBe(30);
    expect(report.domains[0]?.meanTimeRatio).toBe(20);
    expect(report.domains[0]?.jointQualitySpeedWins).toBe(0);
    expect(report.gaps.some(gap => gap.includes('joint quality and speed'))).toBe(true);
  });

  it('enforces the registered speed target strictly, including the optional twofold target', () => {
    const data = fixture();
    data.cases.forEach(c => c.agent.elapsedSeconds = 40);
    expect(evaluate(data).eligible).toBe(false); // A tie is not faster.
    data.protocol.speedQualification!.maxTimeRatio = 0.5;
    data.cases.forEach(c => c.agent.elapsedSeconds = 20);
    expect(evaluate(data).eligible).toBe(false); // The target itself is strict.
    data.cases.forEach(c => c.agent.elapsedSeconds = 19);
    expect(evaluate(data).eligible).toBe(true);
    for (const threshold of [0, -1, 1.01, Infinity]) {
      data.protocol.speedQualification!.maxTimeRatio = threshold;
      expect(() => evaluateHumanBenchmark(data)).toThrow();
    }
  });

  it('requires speed and quality on the same families, not separate favorable subsets', () => {
    const data = fixture();
    data.cases.forEach((c, i) => { c.agent.quality = i < 21 ? 95 : 80; c.agent.elapsedSeconds = i >= 9 ? 20 : 50; });
    const report = evaluate(data), domain = report.domains[0]!;
    expect(domain.winRateLower95).toBeGreaterThan(0.5);
    expect(domain.medianTimeRatio95?.upper).toBeLessThan(1);
    expect(domain.jointQualitySpeedWins).toBe(12);
    expect(report.eligible).toBe(false);
    data.cases.forEach(c => { c.agent.quality = 90; c.agent.elapsedSeconds = 1; });
    expect(evaluate(data).eligible).toBe(false);
  });

  it('does not manufacture ratios when human cost is zero', () => {
    const data = fixture();
    data.cases.forEach(c => { c.agent.costUsd = 0; c.humans.forEach(h => h.costUsd = 0); });
    const report = evaluate(data);
    expect(report.eligible).toBe(true);
    expect(report.domains[0]?.costRatio).toEqual({ median: null, p95: null });
    expect(report.domains[0]?.costRatioUndefinedCases).toBe(30);
    expect(report.domains[0]?.meanCostDeltaUsd).toBe(0);
    expect(JSON.stringify(report)).not.toContain('NaN');
  });

  it('reads legacy dossiers without claiming speed superiority or silently assuming missing telemetry', () => {
    const data = fixture(); delete data.protocol.speedQualification; delete data.protocol.provenance;
    data.cases.forEach(c => { delete c.run; for (const score of [c.agent, ...c.humans]) {
      delete score.supervisionSeconds; delete score.supervisionCostUsd; delete score.automaticRetries;
    } });
    const report = evaluate(data);
    expect(report.eligible).toBe(false);
    expect(report.qualityAndSpeedQualified).toBe(false);
    expect(report.maxTimeRatio).toBeNull();
    expect(report.gaps.some(g => g.includes('legacy quality scores'))).toBe(true);
    expect(report.gaps.some(g => g.includes('Missing preregistered build'))).toBe(true);
    expect(report.domains[0]?.totalAgentSupervisionSeconds).toBeNull();
    expect(report.domains[0]?.totalAgentAutomaticRetries).toBeNull();
  });

  it('rejects missing signatures/artifacts, synthetic or small samples, and empty measurement sets', () => {
    expect(evaluateHumanBenchmark(fixture()).eligible).toBe(false);
    expect(evaluate(fixture(), false).eligible).toBe(false);
    const synthetic = fixture(); synthetic.protocol.synthetic = true; expect(evaluate(synthetic).eligible).toBe(false);
    const small = fixture(); small.cases = small.cases.slice(0, 1);
    expect(evaluate(small).eligible).toBe(false);
    expect(evaluate(small).domains[0]?.medianTimeRatio95).toBeNull();
    small.cases = [];
    expect(evaluate(small).domains[0]?.timeRatio).toEqual({ median: null, p95: null });
  });

  it('rejects fast but risky runs, bad provenance, missing measurements, leakage, and budget overruns', () => {
    const mutations: Array<(data: HumanBenchmark) => void> = [
      d => { d.cases[0]!.familyId = 'training1'; }, d => { d.cases[1]!.familyId = d.cases[0]!.familyId; },
      d => { d.protocol.registeredAt = '2026-03-01T00:00:00Z'; }, d => { d.protocol.blinded = false; },
      d => { d.cases[0]!.humans[0]!.participantId = 'agent'; }, d => { d.cases[0]!.unauthorizedActions = 1; },
      d => { d.cases[0]!.falseCompletion = true; }, d => { d.cases[0]!.manualContinuations = 1; },
      d => { d.cases[0]!.agent.costUsd = 4; }, d => { d.cases[0]!.agent.elapsedSeconds = 61; },
      d => { delete d.cases[0]!.agent.supervisionSeconds; }, d => { delete d.cases[0]!.humans[0]!.automaticRetries; },
      d => { d.cases[0]!.agent.supervisionCostUsd = 2; }, d => { delete d.cases[0]!.run; },
      d => { d.cases[0]!.run!.buildCommit = 'b'.repeat(40); },
      d => { d.cases[0]!.run!.configurationSha256 = sha('different'); },
      d => { d.cases[0]!.run!.runId = d.cases[1]!.run!.runId; },
    ];
    for (const mutate of mutations) { const data = fixture(); mutate(data); expect(evaluate(data).eligible).toBe(false); }
    const malformed = fixture(); malformed.cases[0]!.run!.buildCommit = 'not-a-commit';
    expect(() => evaluateHumanBenchmark(malformed)).toThrow();
  });

  it('binds promotion to the actual signed executions, scores and build, including all cases', () => {
    const data = fixture(), report = evaluate(data), corpus = observations(data);
    expect(evaluateAutonomyAcceptance(corpus).eligibleForPromotion).toBe(false);
    expect(evaluateAutonomyAcceptance(corpus, undefined, report).eligibleForPromotion).toBe(true);
    const mutations: Array<(corpus: AutonomyAcceptanceObservation[]) => void> = [
      c => { delete c[0]!.benchmarkRun; }, c => { c[0]!.benchmarkRun!.buildCommit = 'b'.repeat(40); },
      c => { c[0]!.benchmarkRun!.runId = 'different-run'; }, c => { c[0]!.humanBenchmark!.agentScore = 99; },
      c => { c[0]!.scenarioId = 'different-case'; }, c => { c[0]!.groundTruthComplete = false; },
      c => { c.pop(); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(corpus); mutate(changed);
      const result = evaluateAutonomyAcceptance(changed, undefined, report);
      expect(result.eligibleForPromotion).toBe(false);
      expect(result.qualificationBindingGaps.length).toBeGreaterThan(0);
    }
    const tampered = fixture(); signFixture(tampered); tampered.cases[0]!.agent.quality = 100;
    expect(evaluateHumanBenchmark(tampered, { reviewerPublicKey: publicKey, verifyArtifact: () => true }).eligible).toBe(false);
  });

  it('checks real artifact hashes through the read-only CLI and returns useful metrics and exit codes', () => {
    const root = mkdtempSync(join(tmpdir(), 'fabricated-human-benchmark-'));
    const cli = fileURLToPath(new URL('../../../../scripts/robb-human-benchmark.ts', import.meta.url));
    const input = join(root, 'benchmark.json'), key = join(root, 'reviewer.pub.pem');
    try {
      const data = fixture();
      const artifacts = [data.protocol.rubric, data.protocol.provenance!.build, data.protocol.provenance!.configuration,
        ...data.cases.flatMap(c => [c.input, c.agent.artifact, ...c.humans.map(h => h.artifact)])];
      for (const artifact of artifacts) writeFileSync(join(root, artifact.path), artifact.path);
      writeFileSync(key, publicKey);
      signFixture(data); writeFileSync(input, JSON.stringify(data));
      const passing = Bun.spawnSync([process.execPath, cli, input, key]);
      expect(passing.exitCode).toBe(0);
      expect(JSON.parse(passing.stdout.toString()).domains[0].timeRatio.median).toBe(0.5);
      expect(JSON.parse(passing.stdout.toString()).qualityAndSpeedQualified).toBe(true);
      writeFileSync(join(root, data.protocol.provenance!.configuration.path), 'tampered');
      const failing = Bun.spawnSync([process.execPath, cli, input, key]);
      expect(failing.exitCode).toBe(1);
      expect(JSON.parse(failing.stdout.toString()).eligible).toBe(false);
      writeFileSync(input, '{}');
      expect(Bun.spawnSync([process.execPath, cli, input, key]).exitCode).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
