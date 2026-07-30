import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const rulebookRoot = process.env.RULEBOOK_AI_HOME
  ?? join(process.env.HOME ?? '/Users/thibault', 'code', 'rulebook-ai');
const skillDirectory = join(rulebookRoot, 'skills', 'playwright-skill');
const officialTemplate = join(skillDirectory, 'templates', 'robb-agents.js');
const sourceTemplate = join(repositoryRoot, 'scripts', 'playwright', 'robb-agents.js');
const verifier = join(rulebookRoot, 'scripts', 'playwright-verify.sh');

for (const required of [sourceTemplate, verifier]) {
  if (!existsSync(required)) throw new Error(`Required Playwright validation file is missing: ${required}`);
}

mkdirSync(dirname(officialTemplate), { recursive: true });
copyFileSync(sourceTemplate, officialTemplate);

// Rulebook's provider resolver uses Bash 4 lowercase expansion while macOS
// still ships Bash 3.2. Provide the one resolver function needed by the
// official verifier, then source that verifier unchanged in the same shell.
const verification = Bun.spawn([
  '/bin/bash',
  '-c',
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
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(await verification.exited);
