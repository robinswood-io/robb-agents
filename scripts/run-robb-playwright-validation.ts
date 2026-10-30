import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const rulebookRoot = process.env["RULEBOOK_AI_HOME"]
  ?? join(process.env["HOME"] ?? '/Users/thibault', 'code', 'rulebook-ai');
const skillSource = join(rulebookRoot, 'skills', 'playwright-skill');
const sourceTemplate = join(repositoryRoot, 'scripts', 'playwright', 'robb-agents.ts');
const verifier = join(rulebookRoot, 'scripts', 'playwright-verify.sh');
for (const required of [sourceTemplate, verifier, join(skillSource, 'run.js'), join(skillSource, 'lib')]) {
  if (!existsSync(required)) throw new Error(`Required Playwright validation file is missing: ${required}`);
}
// Keep the official executor unchanged, and never overwrite the shared Rulebook.
const skillDirectory = mkdtempSync(join(tmpdir(), 'robb-playwright-'));
try {
  cpSync(join(skillSource, 'run.js'), join(skillDirectory, 'run.js'));
  cpSync(join(skillSource, 'lib'), join(skillDirectory, 'lib'), { recursive: true });
  // The executor is CommonJS; the generated scenario uses Node's ESM detection.
  // Resolve Playwright from this project's pinned installation.
  symlinkSync(join(repositoryRoot, 'node_modules'), join(skillDirectory, 'node_modules'), 'junction');
  const officialTemplate = join(skillDirectory, 'templates', 'robb-agents.js');
  mkdirSync(dirname(officialTemplate), { recursive: true });
  const compiled = new Bun.Transpiler({ loader: 'ts', target: 'node' })
    .transformSync(readFileSync(sourceTemplate, 'utf8'));
  writeFileSync(officialTemplate, compiled);
  // Rulebook's provider resolver uses Bash 4 lowercase expansion while macOS
  // ships Bash 3.2. Supply its resolver, then source the official verifier unchanged.
  const verification = Bun.spawn([
    '/bin/bash', '-c',
    `rb_skills_dir() { printf '%s\\n' "$PLAYWRIGHT_SKILL_DIR"; }
export RB_PROVIDER_PATHS_LOADED=1
source "$PLAYWRIGHT_VERIFIER" robb-agents`,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_SKILL_DIR: skillDirectory,
      PLAYWRIGHT_VERIFIER: verifier,
      PLAYWRIGHT_AUTO_E2E: '0',
    },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  });
  process.exitCode = await verification.exited;
} finally {
  rmSync(skillDirectory, { recursive: true, force: true });
}
