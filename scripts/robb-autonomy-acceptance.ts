import { evaluateHumanBenchmarkFile } from './robb-human-benchmark.ts';
import { readFile } from 'node:fs/promises';
import {
  evaluateAutonomyAcceptance,
  parseAutonomyAcceptanceObservations,
} from '../packages/server-core/src/sessions/autonomy-acceptance.ts';

// Read-only qualification of externally adjudicated run observations. This
// command never launches an agent, changes configuration, or promotes a build.
const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('Usage: bun run scripts/robb-autonomy-acceptance.ts <observations.json> [benchmark.json independent-reviewer.pub.pem]');
  process.exitCode = 2;
} else {
  try {
    const observations = parseAutonomyAcceptanceObservations(JSON.parse(await readFile(corpusPath, 'utf8')));
    const qualification = process.argv[3] ? evaluateHumanBenchmarkFile(process.argv[3], process.argv[4]) : undefined;
    const report = evaluateAutonomyAcceptance(observations, undefined, qualification);
    console.log(JSON.stringify(report, null, 2));
    if (!report.eligibleForPromotion) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
