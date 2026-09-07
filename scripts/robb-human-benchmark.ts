import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { evaluateHumanBenchmark } from '../packages/server-core/src/sessions/human-benchmark.ts';

export function evaluateHumanBenchmarkFile(input: string, publicKeyPath?: string) {
  const root = realpathSync(dirname(resolve(input)));
  return evaluateHumanBenchmark(JSON.parse(readFileSync(input, 'utf8')), {
    reviewerPublicKey: publicKeyPath ? readFileSync(publicKeyPath, 'utf8') : undefined,
    verifyArtifact: artifact => {
      try {
        const path = realpathSync(resolve(root, artifact.path));
        const rel = relative(root, path);
        if (isAbsolute(artifact.path) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
        return createHash('sha256').update(readFileSync(path)).digest('hex') === artifact.sha256;
      } catch { return false; }
    },
  });
}
if (import.meta.main) {
  try {
    if (!process.argv[2]) throw new Error('Usage: bun scripts/robb-human-benchmark.ts benchmark.json [independent-reviewer.pub.pem]');
    const report = evaluateHumanBenchmarkFile(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.eligible ? 0 : 1;
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; }
}
