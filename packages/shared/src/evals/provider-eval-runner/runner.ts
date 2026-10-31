import { createEvalReport, type EvalCase, type EvalCaseResult, type EvalReport, type EvalRuntimeVersions } from "../eval-gate.ts";
import type { CompletedGraderOutcome, EvalGrader, EvalJob, EvalObservationProvider, ProviderEvalResponse, ProviderJudgeScore } from './contracts.ts';
import { asCompletedOutcome, combineGraderOutcomes, gradeDeterministicText, gradeExpectedState, gradeTrajectory, parseProviderJudgeScore, publicGraderResult } from './grading.ts';
import { ProviderEvalHttpClient, digest } from './http-client.ts';
import { buildProviderEvalJudgePrompt, buildProviderEvalTargetPrompt } from './prompts.ts';

export interface ProviderEvalRunInput {
  corpusId: string;
  corpusVersion: string;
  runId: string;
  cases: EvalCase[];
  versions: EvalRuntimeVersions;
  target: ProviderEvalHttpClient;
  judge: ProviderEvalHttpClient;
  createdAt?: string;
  /** Number of independent samples for each case. Defaults to one. */
  repetitions?: number;
  /** Maximum number of case samples evaluated concurrently. Defaults to one. */
  concurrency?: number;
  /** Optional state and tool trajectory captured by a real harness. */
  observeCase?: EvalObservationProvider;
  /** Additional graders composed with the built-in LLM and corpus graders. */
  graders?: EvalGrader[];
}

function assertRequiredCategorySignal(
  evalCase: EvalCase,
  score: ProviderJudgeScore,
): void {
  if (evalCase.category === 'tool-use' && score.toolSucceeded === undefined) {
    throw new Error('Provider judge omitted required toolSucceeded signal');
  }
  if (
    evalCase.category === 'destructive-action'
    && score.destructiveActionSafe === undefined
  ) {
    throw new Error('Provider judge omitted required destructiveActionSafe signal');
  }
  if (
    evalCase.category === 'provider-error'
    && score.providerErrorRecovered === undefined
  ) {
    throw new Error('Provider judge omitted required providerErrorRecovered signal');
  }
}

function judgePassedForCategory(
  evalCase: EvalCase,
  score: ProviderJudgeScore,
): boolean {
  switch (evalCase.category) {
    case 'tool-use':
      return score.policyCompliant && score.toolSucceeded === true;
    case 'destructive-action':
      return score.policyCompliant && score.destructiveActionSafe === true;
    case 'provider-error':
      return score.policyCompliant && score.providerErrorRecovered === true;
    case 'confidentiality':
    case 'factuality':
    case 'policy':
      return score.passed;
  }
}

function resultEvidence(
  response: ProviderEvalResponse,
  judge: ProviderEvalResponse,
  score: ProviderJudgeScore,
): string[] {
  return [
    `target:${response.provider}/${response.model}`,
    `target-output-sha256:${response.outputDigest}`,
    ...(response.requestId ? [`target-request:${response.requestId}`] : []),
    `judge:${judge.provider}/${judge.model}`,
    `judge-output-sha256:${judge.outputDigest}`,
    ...(judge.requestId ? [`judge-request:${judge.requestId}`] : []),
    `judge-summary-sha256:${digest(score.evidenceSummary)}`,
    ...(response.pricingCatalogVersion
      ? [`pricing:${response.pricingCatalogVersion}`]
      : []),
  ];
}

async function runCase(
  evalCase: EvalCase,
  input: ProviderEvalRunInput,
  repetition: number,
): Promise<EvalCaseResult> {
  const response = await input.target.generate(buildProviderEvalTargetPrompt(evalCase));
  const observation = input.observeCase
    ? await input.observeCase(evalCase, response, repetition)
    : {};
  const judgeResponse = await input.judge.generate(
    buildProviderEvalJudgePrompt(evalCase, response),
  );
  const score = parseProviderJudgeScore(judgeResponse.outputText);
  assertRequiredCategorySignal(evalCase, score);
  const outcomes: CompletedGraderOutcome[] = [
    asCompletedOutcome('llm-judge', 'llm', {
      passed: judgePassedForCategory(evalCase, score),
      score: score.factualityScore,
      policyCompliant: score.policyCompliant,
      ...(score.toolSucceeded !== undefined ? { toolSucceeded: score.toolSucceeded } : {}),
      ...(score.destructiveActionSafe !== undefined ? { destructiveActionSafe: score.destructiveActionSafe } : {}),
      ...(score.providerErrorRecovered !== undefined ? { providerErrorRecovered: score.providerErrorRecovered } : {}),
      evidenceSummary: score.evidenceSummary,
    }),
  ];
  const deterministic = gradeDeterministicText(evalCase, response.outputText);
  if (deterministic) {
    outcomes.push(asCompletedOutcome(
      'corpus-text',
      'deterministic',
      deterministic,
    ));
  }
  const state = gradeExpectedState(evalCase, observation);
  if (state) outcomes.push(asCompletedOutcome('corpus-state', 'state', state));
  const trajectory = gradeTrajectory(evalCase, observation);
  if (trajectory) {
    outcomes.push(asCompletedOutcome(
      'corpus-trajectory',
      'trajectory',
      trajectory,
    ));
  }
  for (const grader of input.graders ?? []) {
    const outcome = await grader.grade({
      evalCase,
      response,
      observation,
      repetition,
    });
    outcomes.push(asCompletedOutcome(
      grader.id,
      grader.kind,
      outcome,
      grader.required ?? true,
      grader.weight ?? 1,
    ));
  }
  const combined = combineGraderOutcomes(outcomes);
  const deterministicOutcome = outcomes.find(outcome =>
    outcome.kind === 'deterministic',
  );
  const stateOutcome = outcomes.find(outcome => outcome.kind === 'state');
  const trajectoryOutcome = outcomes.find(outcome =>
    outcome.kind === 'trajectory',
  );
  const knownCosts = [response.costUsd, judgeResponse.costUsd].flatMap(value =>
    value === null ? [] : [value],
  );
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    passed: combined.passed,
    policyCompliant: combined.policyCompliant,
    factualityScore: combined.factualityScore,
    latencyMs: response.latencyMs + judgeResponse.latencyMs,
    targetLatencyMs: response.latencyMs,
    judgeLatencyMs: judgeResponse.latencyMs,
    costUsd: knownCosts.length === 0
      ? null
      : knownCosts.reduce((sum, value) => sum + value, 0),
    humanInterventionRequired: score.humanInterventionRequired,
    repetition,
    ...(evalCase.category === 'tool-use'
      ? { toolSucceeded: combined.toolSucceeded ?? false }
      : {}),
    ...(evalCase.category === 'destructive-action'
      ? { destructiveActionSafe: combined.destructiveActionSafe ?? false }
      : {}),
    ...(evalCase.category === 'provider-error'
      ? { providerErrorRecovered: combined.providerErrorRecovered ?? false }
      : {}),
    ...(deterministicOutcome
      ? { deterministicCriteriaPassed: deterministicOutcome.passed }
      : {}),
    ...(stateOutcome ? { stateMatched: stateOutcome.passed } : {}),
    ...(trajectoryOutcome
      ? { trajectorySucceeded: trajectoryOutcome.passed }
      : {}),
    graderResults: outcomes.map(publicGraderResult),
    evidence: [
      ...resultEvidence(response, judgeResponse, score),
      ...outcomes.map(outcome =>
        `grader:${outcome.graderId}:${outcome.passed ? 'pass' : 'fail'}:${outcome.evidenceSummary}`,
      ),
    ],
  };
}

function failedCaseResult(
  evalCase: EvalCase,
  repetition: number,
  error: unknown,
): EvalCaseResult {
  const errorName = error instanceof Error && error.name.trim()
    ? error.name.trim().slice(0, 80)
    : 'UnknownError';
  const errorMessage = error instanceof Error ? error.message : '';
  const errorCode = errorMessage.startsWith('Provider judge omitted required ')
    ? 'judge-category-signal-missing'
    : errorMessage.startsWith('Provider eval request failed with HTTP ')
      ? `provider-http-${errorMessage.slice('Provider eval request failed with HTTP '.length).replace(/\D/g, '').slice(0, 3) || 'error'}`
      : errorMessage === 'Provider judge response does not match the score contract'
        ? 'judge-contract-invalid'
        : error instanceof SyntaxError
          ? 'provider-json-invalid'
          : errorName;
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    passed: false,
    policyCompliant: false,
    factualityScore: 0,
    latencyMs: 0,
    costUsd: null,
    humanInterventionRequired: true,
    repetition,
    ...(evalCase.category === 'tool-use' ? { toolSucceeded: false } : {}),
    ...(evalCase.category === 'destructive-action'
      ? { destructiveActionSafe: false }
      : {}),
    ...(evalCase.category === 'provider-error'
      ? { providerErrorRecovered: false }
      : {}),
    evidence: [`runner-error:${errorCode}`],
  };
}

export async function runProviderEvalCorpus(
  input: ProviderEvalRunInput,
): Promise<EvalReport> {
  const repetitions = Math.min(100, Math.max(1, Math.trunc(input.repetitions ?? 1)));
  const concurrency = Math.min(32, Math.max(1, Math.trunc(input.concurrency ?? 1)));
  const jobs: EvalJob[] = input.cases.flatMap(evalCase =>
    Array.from({ length: repetitions }, (_, index) => ({
      evalCase,
      repetition: index + 1,
    })),
  );
  const results = new Array<EvalCaseResult>(jobs.length);
  let nextJobIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextJobIndex < jobs.length) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      const job = jobs[jobIndex];
      if (!job) continue;
      try {
        results[jobIndex] = await runCase(
          job.evalCase,
          input,
          job.repetition,
        );
      } catch (error) {
        results[jobIndex] = failedCaseResult(
          job.evalCase,
          job.repetition,
          error,
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, jobs.length)) },
      () => worker(),
    ),
  );
  return createEvalReport({
    corpusId: input.corpusId,
    corpusVersion: input.corpusVersion,
    runId: input.runId,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    versions: input.versions,
    results: results.filter((result): result is EvalCaseResult => result !== undefined),
  });
}
