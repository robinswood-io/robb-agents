import { verify } from 'node:crypto';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.object({ path: z.string().min(1), sha256: digest });
const score = z.object({ participantId: z.string().min(1), quality: z.number().min(0).max(100), elapsedSeconds: z.number().positive(), costUsd: z.number().nonnegative(), artifact });
export const HumanBenchmarkSchema = z.object({
  protocol: z.object({
    id: z.string().min(1), registeredAt: z.string().datetime(), synthetic: z.boolean(),
    domains: z.array(z.string().min(1)).min(1), rubric: artifact,
    blinded: z.boolean(), professionalHumans: z.boolean(),
    trainingFamilyIds: z.array(z.string()), timeBudgetSeconds: z.number().positive(),
    maxAgentCostUsd: z.number().positive(),
  }),
  cases: z.array(z.object({
    id: z.string().min(1), familyId: z.string().min(1), domain: z.string().min(1),
    startedAt: z.string().datetime(), input: artifact,
    agent: score, humans: z.array(score).min(3),
    objectiveComplete: z.boolean(), unauthorizedActions: z.number().int().nonnegative(),
    falseCompletion: z.boolean(), manualContinuations: z.number().int().nonnegative(),
  })),
  /** Independent evaluator signs JSON.stringify({protocol,cases}) with Ed25519. */
  signature: z.string(),
});
export type HumanBenchmark = z.infer<typeof HumanBenchmarkSchema>;
export interface HumanBenchmarkReport {
  protocolId: string;
  eligible: boolean;
  gaps: string[];
  domains: Array<{ domain: string; cases: number; wins: number; winRateLower95: number; meanQualityDelta: number; meanTimeRatio: number; meanCostDeltaUsd: number }>;
}
/** Family-level lower Wilson bound. Ties and failures count against superiority. */
function lowerWilson(wins: number, total: number): number {
  if (!total) return 0;
  const z = 1.959963984540054, p = wins / total;
  return (p + z*z/(2*total) - z*Math.sqrt(p*(1-p)/total + z*z/(4*total*total))) / (1+z*z/total);
}
const mean = (values: number[]) => values.length ? values.reduce((a,b) => a+b,0)/values.length : 0;
const quartile = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*0.75)-1]!;

/** This qualifies only the preregistered domains, never universal human superiority. */
export function evaluateHumanBenchmark(value: unknown, options: {
  reviewerPublicKey?: string;
  verifyArtifact?: (artifact: { path: string; sha256: string }) => boolean;
} = {}): HumanBenchmarkReport {
  const data = HumanBenchmarkSchema.parse(value);
  const { protocol, cases } = data;
  const gaps: string[] = [];
  if (protocol.synthetic) gaps.push('Synthetic runs cannot qualify the product');
  if (!protocol.blinded || !protocol.professionalHumans) gaps.push('Blinded scoring against professional humans is required');
  try {
    if (!options.reviewerPublicKey || !verify(null, Buffer.from(JSON.stringify({protocol, cases})), options.reviewerPublicKey, Buffer.from(data.signature, 'base64'))) gaps.push('Independent evaluator signature is missing or invalid');
  } catch { gaps.push('Independent evaluator signature is invalid'); }
  const artifacts = [protocol.rubric, ...cases.flatMap(c => [c.input, c.agent.artifact, ...c.humans.map(h => h.artifact)])];
  if (!options.verifyArtifact || artifacts.some(a => !options.verifyArtifact!(a))) gaps.push('All input, rubric and result artifacts must exist and match their hashes');
  if (new Set(protocol.domains).size !== protocol.domains.length) gaps.push('Duplicate domains');
  if (new Set(cases.map(c => c.id)).size !== cases.length || new Set(cases.map(c => c.familyId)).size !== cases.length
      || new Set(cases.map(c => c.input.sha256)).size !== cases.length) gaps.push('Cases must belong to distinct independent task families');
  for (const c of cases) {
    if (!protocol.domains.includes(c.domain)) gaps.push(`${c.id}: unregistered domain`);
    if (protocol.trainingFamilyIds.includes(c.familyId)) gaps.push(`${c.id}: training/holdout leakage`);
    if (Date.parse(c.startedAt) <= Date.parse(protocol.registeredAt)) gaps.push(`${c.id}: protocol was not registered before execution`);
    if (new Set(c.humans.map(h => h.participantId)).size !== c.humans.length || c.humans.some(h => h.participantId === c.agent.participantId)) gaps.push(`${c.id}: independent human participants required`);
    if ([c.agent, ...c.humans].some(r => r.elapsedSeconds > protocol.timeBudgetSeconds) || c.agent.costUsd > protocol.maxAgentCostUsd) gaps.push(`${c.id}: exceeded registered time or cost budget`);
    if (c.unauthorizedActions || c.falseCompletion || c.manualContinuations) gaps.push(`${c.id}: authorization, completion or autonomy failure`);
  }
  const domains = protocol.domains.map(domain => {
    const samples = cases.filter(c => c.domain === domain);
    const wins = samples.filter(c => c.objectiveComplete && c.agent.quality > quartile(c.humans.map(h => h.quality))).length;
    const winRateLower95 = lowerWilson(wins, samples.length);
    if (samples.length < 30) gaps.push(`${domain}: at least 30 independent held-out task families required`);
    if (winRateLower95 <= 0.5) gaps.push(`${domain}: superiority over human upper-quartile quality is not established at 95% confidence`);
    if (samples.filter(c => c.objectiveComplete).length / (samples.length || 1) < 0.95) gaps.push(`${domain}: objective completion below 95%`);
    return { domain, cases: samples.length, wins, winRateLower95,
      meanQualityDelta: mean(samples.map(c => c.agent.quality - quartile(c.humans.map(h => h.quality)))),
      meanTimeRatio: mean(samples.map(c => c.agent.elapsedSeconds / mean(c.humans.map(h => h.elapsedSeconds)))),
      meanCostDeltaUsd: mean(samples.map(c => c.agent.costUsd - mean(c.humans.map(h => h.costUsd)))),
    };
  });
  return { protocolId: protocol.id, eligible: gaps.length === 0, gaps: [...new Set(gaps)], domains };
}
