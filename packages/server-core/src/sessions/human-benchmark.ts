import { verify } from 'node:crypto';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const artifact = z.object({ path: z.string().min(1), sha256: digest });
const nonnegative = z.number().finite().nonnegative();
const score = z.object({
  participantId: z.string().min(1), quality: z.number().finite().min(0).max(100),
  elapsedSeconds: z.number().finite().positive(), costUsd: nonnegative, artifact,
  // Optional only to read historical dossiers. Missing measurements cannot qualify.
  supervisionSeconds: nonnegative.optional(), supervisionCostUsd: nonnegative.optional(),
  automaticRetries: nonnegative.int().optional(),
});
export const BenchmarkRunIdentitySchema = z.object({
  runId: z.string().min(1), protocolId: z.string().min(1), buildCommit: commit,
  buildSha256: digest, configurationSha256: digest,
});
export type BenchmarkRunIdentity = z.infer<typeof BenchmarkRunIdentitySchema>;
export const HumanBenchmarkSchema = z.object({
  protocol: z.object({
    id: z.string().min(1), registeredAt: z.string().datetime(), synthetic: z.boolean(),
    domains: z.array(z.string().min(1)).min(1), rubric: artifact,
    blinded: z.boolean(), professionalHumans: z.boolean(),
    trainingFamilyIds: z.array(z.string()), timeBudgetSeconds: z.number().finite().positive(),
    maxAgentCostUsd: z.number().finite().positive(),
    speedQualification: z.object({
      // Omission inside an explicit speed protocol means strictly faster (< 1).
      maxTimeRatio: z.number().finite().positive().max(1).optional(),
      humanBaseline: z.literal('median-professional-human'),
      elapsedDefinition: z.literal('start-to-verified-outcome'),
      costDefinition: z.literal('total-including-supervision'),
    }).optional(),
    provenance: z.object({ buildCommit: commit, build: artifact, configuration: artifact }).optional(),
  }),
  cases: z.array(z.object({
    id: z.string().min(1), familyId: z.string().min(1), domain: z.string().min(1),
    startedAt: z.string().datetime(), input: artifact,
    agent: score, humans: z.array(score).min(3),
    objectiveComplete: z.boolean(), unauthorizedActions: nonnegative.int(),
    falseCompletion: z.boolean(), manualContinuations: nonnegative.int(),
    run: BenchmarkRunIdentitySchema.optional(),
  })),
  /** Independent evaluator signs the schema-normalized protocol and cases. */
  signature: z.string(),
});
export type HumanBenchmark = z.infer<typeof HumanBenchmarkSchema>;
type Distribution = { median: number | null; p95: number | null };
type Interval = { lower: number; upper: number };
export interface HumanBenchmarkCaseBinding {
  scenarioId: string;
  run?: BenchmarkRunIdentity;
  domain: string;
  agentScore: number;
  humanTopQuartileScore: number;
  objectiveComplete: boolean;
  falseCompletion: boolean;
  manualContinuations: number;
  unauthorizedActions: number;
}
export interface HumanBenchmarkDomainReport {
  domain: string; cases: number; wins: number; winRateLower95: number;
  meanQualityDelta: number | null; meanTimeRatio: number | null; meanCostDeltaUsd: number | null;
  jointQualitySpeedWins: number; jointWinRateLower95: number;
  timeRatio: Distribution; medianTimeRatio95: Interval | null;
  agentElapsedSeconds: Distribution; humanBaselineElapsedSeconds: Distribution;
  agentCostUsd: Distribution; humanBaselineCostUsd: Distribution;
  costRatio: Distribution; costRatioUndefinedCases: number;
  agentSupervisionSeconds: Distribution;
  totalAgentSupervisionSeconds: number | null; totalAgentSupervisionCostUsd: number | null;
  totalAgentCostUsd: number; totalHumanCostUsd: number;
  totalAgentAutomaticRetries: number | null;
  manualContinuations: number; falseCompletions: number; unauthorizedActions: number;
  objectiveCompletionRate: number;
}
export interface HumanBenchmarkReport {
  protocolId: string;
  eligible: boolean;
  /** True only when the entire signed, provenance-bound joint protocol passes. */
  qualityAndSpeedQualified: boolean;
  maxTimeRatio: number | null;
  provenance?: HumanBenchmark['protocol']['provenance'];
  cases: HumanBenchmarkCaseBinding[];
  gaps: string[];
  domains: HumanBenchmarkDomainReport[];
}

/** Ties and failures count against superiority; independent families are the units. */
function lowerWilson(wins: number, total: number): number {
  if (!total) return 0;
  const z = 1.959963984540054, p = wins / total;
  return (p + z*z/(2*total) - z*Math.sqrt(p*(1-p)/total + z*z/(4*total*total))) / (1+z*z/total);
}
const mean = (values: number[]) => values.length ? values.reduce((a,b) => a+b,0)/values.length : 0;
const sum = (values: number[]) => values.reduce((a,b) => a+b, 0);
const quartile = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*0.75)-1]!;
function distribution(values: number[]): Distribution {
  if (!values.length) return { median: null, p95: null };
  const sorted = [...values].sort((a,b) => a-b), middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle-1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length*0.95)-1]!,
  };
}
function completeSum(values: Array<number | undefined>): number | null {
  const known = values.filter((value): value is number => value !== undefined);
  return !values.length || known.length !== values.length ? null : sum(known);
}
/** Exact conservative, distribution-free median interval from binomial order statistics.
 * Relative probabilities around the mode avoid underflow for large family samples.
 * Fewer than six families have no finite two-sided 95% interval and return null.
 */
function medianInterval95(values: number[]): Interval | null {
  const n = values.length;
  if (n < 6) return null;
  const weights = Array<number>(n+1).fill(0), mode = Math.floor(n/2);
  weights[mode] = 1;
  for (let k = mode; k > 0; k--) weights[k-1] = weights[k]! * k / (n-k+1);
  for (let k = mode; k < n; k++) weights[k+1] = weights[k]! * (n-k) / (k+1);
  const total = sum(weights);
  let tail = 0, index = -1;
  for (let k = 0; k < mode; k++) {
    tail += weights[k]! / total;
    if (tail <= 0.025) index = k;
    else break;
  }
  if (index < 0) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return { lower: sorted[index]!, upper: sorted[n-1-index]! };
}
/** Sign these exact UTF-8 bytes; optional defaults never change a legacy payload. */
export function humanBenchmarkSignedPayload(value: unknown): string {
  const { protocol, cases } = HumanBenchmarkSchema.parse(value);
  return JSON.stringify({ protocol, cases });
}

/** Qualifies only preregistered domains, never universal human superiority. */
export function evaluateHumanBenchmark(value: unknown, options: {
  reviewerPublicKey?: string;
  verifyArtifact?: (artifact: { path: string; sha256: string }) => boolean;
} = {}): HumanBenchmarkReport {
  const data = HumanBenchmarkSchema.parse(value);
  const { protocol, cases } = data;
  const gaps: string[] = [];
  const threshold = protocol.speedQualification?.maxTimeRatio ?? 1;
  if (protocol.synthetic) gaps.push('Synthetic runs cannot qualify the product');
  if (!protocol.blinded || !protocol.professionalHumans) gaps.push('Blinded scoring against professional humans is required');
  if (!protocol.speedQualification) gaps.push('Missing preregistered speed protocol: legacy quality scores cannot establish speed superiority');
  if (!protocol.provenance) gaps.push('Missing preregistered build and configuration provenance');
  try {
    if (!options.reviewerPublicKey || !verify(null, Buffer.from(humanBenchmarkSignedPayload(data)), options.reviewerPublicKey, Buffer.from(data.signature, 'base64'))) gaps.push('Independent evaluator signature is missing or invalid');
  } catch { gaps.push('Independent evaluator signature is invalid'); }
  const artifacts = [protocol.rubric, ...(protocol.provenance ? [protocol.provenance.build, protocol.provenance.configuration] : []),
    ...cases.flatMap(c => [c.input, c.agent.artifact, ...c.humans.map(h => h.artifact)])];
  if (!options.verifyArtifact || artifacts.some(a => !options.verifyArtifact!(a))) gaps.push('All input, rubric, build, configuration and result artifacts must exist and match their hashes');
  if (new Set(protocol.domains).size !== protocol.domains.length) gaps.push('Duplicate domains');
  if (new Set(cases.map(c => c.id)).size !== cases.length || new Set(cases.map(c => c.familyId)).size !== cases.length
      || new Set(cases.map(c => c.input.sha256)).size !== cases.length) gaps.push('Cases must belong to distinct independent task families');
  const runIds = cases.flatMap(c => c.run ? [c.run.runId] : []);
  if (new Set(runIds).size !== runIds.length) gaps.push('Each family requires a distinct execution run');
  for (const c of cases) {
    if (!protocol.domains.includes(c.domain)) gaps.push(`${c.id}: unregistered domain`);
    if (protocol.trainingFamilyIds.includes(c.familyId)) gaps.push(`${c.id}: training/holdout leakage`);
    if (Date.parse(c.startedAt) <= Date.parse(protocol.registeredAt)) gaps.push(`${c.id}: protocol was not registered before execution`);
    if (new Set(c.humans.map(h => h.participantId)).size !== c.humans.length || c.humans.some(h => h.participantId === c.agent.participantId)) gaps.push(`${c.id}: independent human participants required`);
    if ([c.agent, ...c.humans].some(r => r.elapsedSeconds > protocol.timeBudgetSeconds) || c.agent.costUsd > protocol.maxAgentCostUsd) gaps.push(`${c.id}: exceeded registered time or cost budget`);
    if (c.unauthorizedActions || c.falseCompletion || c.manualContinuations) gaps.push(`${c.id}: authorization, completion or autonomy failure`);
    if (!c.run || c.run.protocolId !== protocol.id || c.run.buildCommit !== protocol.provenance?.buildCommit
        || c.run.buildSha256 !== protocol.provenance?.build.sha256 || c.run.configurationSha256 !== protocol.provenance?.configuration.sha256) gaps.push(`${c.id}: execution provenance missing or different from the registered build/configuration`);
    for (const participant of [c.agent, ...c.humans]) {
      if (participant.supervisionSeconds === undefined || participant.supervisionCostUsd === undefined || participant.automaticRetries === undefined) gaps.push(`${c.id}/${participant.participantId}: missing supervision, total-cost accounting or retry measurements`);
      if (participant.supervisionCostUsd !== undefined && participant.supervisionCostUsd > participant.costUsd) gaps.push(`${c.id}/${participant.participantId}: supervision cost exceeds declared total cost`);
    }
  }
  const domains = protocol.domains.map(domain => {
    const samples = cases.filter(c => c.domain === domain);
    const ratios = samples.map(c => c.agent.elapsedSeconds / distribution(c.humans.map(h => h.elapsedSeconds)).median!);
    const qualityWins = samples.map(c => c.objectiveComplete && c.agent.quality > quartile(c.humans.map(h => h.quality)));
    const wins = qualityWins.filter(Boolean).length;
    const jointQualitySpeedWins = qualityWins.filter((win, index) => win && ratios[index]! < threshold).length;
    const winRateLower95 = lowerWilson(wins, samples.length);
    const jointWinRateLower95 = lowerWilson(jointQualitySpeedWins, samples.length);
    const medianTimeRatio95 = medianInterval95(ratios);
    const completionRate = samples.filter(c => c.objectiveComplete).length / (samples.length || 1);
    if (samples.length < 30) gaps.push(`${domain}: at least 30 independent held-out task families required`);
    if (winRateLower95 <= 0.5) gaps.push(`${domain}: superiority over human upper-quartile quality is not established at 95% confidence`);
    if (jointWinRateLower95 <= 0.5) gaps.push(`${domain}: joint quality and speed superiority (time ratio strictly below ${threshold}) is not established at 95% confidence`);
    if (!medianTimeRatio95 || medianTimeRatio95.upper >= threshold) gaps.push(`${domain}: median time-ratio upper 95% bound must be strictly below ${threshold}`);
    if (completionRate < 0.95) gaps.push(`${domain}: objective completion below 95%`);
    const humanCosts = samples.map(c => mean(c.humans.map(h => h.costUsd)));
    const costRatios = samples.flatMap((c, i) => humanCosts[i]! > 0 ? [c.agent.costUsd / humanCosts[i]!] : []);
    const supervision = samples.flatMap(c => c.agent.supervisionSeconds === undefined ? [] : [c.agent.supervisionSeconds]);
    return { domain, cases: samples.length, wins, winRateLower95, jointQualitySpeedWins, jointWinRateLower95,
      meanQualityDelta: samples.length ? mean(samples.map(c => c.agent.quality - quartile(c.humans.map(h => h.quality)))) : null,
      meanTimeRatio: samples.length ? mean(ratios) : null,
      meanCostDeltaUsd: samples.length ? mean(samples.map((c,i) => c.agent.costUsd - humanCosts[i]!)) : null,
      timeRatio: distribution(ratios), medianTimeRatio95,
      agentElapsedSeconds: distribution(samples.map(c => c.agent.elapsedSeconds)),
      humanBaselineElapsedSeconds: distribution(samples.map(c => distribution(c.humans.map(h => h.elapsedSeconds)).median!)),
      agentCostUsd: distribution(samples.map(c => c.agent.costUsd)), humanBaselineCostUsd: distribution(humanCosts),
      costRatio: distribution(costRatios), costRatioUndefinedCases: samples.length - costRatios.length,
      agentSupervisionSeconds: distribution(supervision.length === samples.length ? supervision : []),
      totalAgentSupervisionSeconds: completeSum(samples.map(c => c.agent.supervisionSeconds)),
      totalAgentSupervisionCostUsd: completeSum(samples.map(c => c.agent.supervisionCostUsd)),
      totalAgentCostUsd: sum(samples.map(c => c.agent.costUsd)), totalHumanCostUsd: sum(samples.flatMap(c => c.humans.map(h => h.costUsd))),
      totalAgentAutomaticRetries: completeSum(samples.map(c => c.agent.automaticRetries)),
      manualContinuations: sum(samples.map(c => c.manualContinuations)), falseCompletions: samples.filter(c => c.falseCompletion).length,
      unauthorizedActions: sum(samples.map(c => c.unauthorizedActions)), objectiveCompletionRate: completionRate,
    };
  });
  return { protocolId: protocol.id, eligible: gaps.length === 0, qualityAndSpeedQualified: gaps.length === 0,
    maxTimeRatio: protocol.speedQualification ? threshold : null, provenance: protocol.provenance,
    cases: cases.map(c => ({ scenarioId: c.id, run: c.run, domain: c.domain, agentScore: c.agent.quality,
      humanTopQuartileScore: quartile(c.humans.map(h => h.quality)), objectiveComplete: c.objectiveComplete,
      falseCompletion: c.falseCompletion, manualContinuations: c.manualContinuations, unauthorizedActions: c.unauthorizedActions })),
    gaps: [...new Set(gaps)], domains };
}
