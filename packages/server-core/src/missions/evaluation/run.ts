import { writeFileSync } from 'fs';
import {
  evaluateMissionWorkspace,
  type MissionWorkspaceEvaluation,
} from './MissionEvaluation.ts';
import {
  renderMissionEvaluationMarkdown,
  runMissionEvaluationCampaign,
  type MissionEvaluationCampaignReport,
} from './MissionEvaluationCampaign.ts';

interface CliOptions {
  workspace?: string;
  format: 'json' | 'markdown';
  output?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { format: 'markdown' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace') options.workspace = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--format') {
      const value = argv[++index];
      if (value !== 'json' && value !== 'markdown') throw new Error('--format must be json or markdown');
      options.format = value;
    } else if (argument === '--help') {
      console.log('Usage: bun run .../evaluation/run.ts [--workspace PATH] [--format json|markdown] [--output FILE]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (argv.includes('--workspace') && !options.workspace) throw new Error('--workspace requires a path');
  if (argv.includes('--output') && !options.output) throw new Error('--output requires a path');
  return options;
}

function renderWorkspaceMarkdown(report: MissionWorkspaceEvaluation): string {
  return [
    '# Mission V2 — audit shadow du workspace',
    '',
    `Workspace: ${report.workspaceRoot}`,
    '',
    `- Missions: ${report.summary.missionCount}`,
    `- Missions sans violation bloquante: ${report.summary.passingMissions}`,
    `- Violations bloquantes: ${report.summary.guardrailFailures}`,
    `- Couverture télémétrie observée: ${(report.summary.telemetryCoverageRate * 100).toFixed(1)}%`,
    `- Coût observé: $${report.summary.totalCostUsd.toFixed(4)} (${report.summary.totalTokens} jetons)`,
    '',
    ...report.missions.map((mission) =>
      `- ${mission.passed ? 'PASS' : 'FAIL'} — ${mission.missionId}: ${mission.status}`),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let report: MissionEvaluationCampaignReport | MissionWorkspaceEvaluation;
  let eligible: boolean;
  if (options.workspace) {
    report = evaluateMissionWorkspace(options.workspace);
    eligible = report.summary.guardrailFailures === 0;
  } else {
    report = await runMissionEvaluationCampaign();
    eligible = report.promotion.eligible;
  }
  const output = options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : report.mode === 'deterministic-corpus'
      ? renderMissionEvaluationMarkdown(report)
      : renderWorkspaceMarkdown(report);
  if (options.output) writeFileSync(options.output, output, 'utf-8');
  else process.stdout.write(output);
  if (!eligible) process.exitCode = 1;
}

await main();
