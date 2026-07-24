import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const rulebookRoot = process.env.RULEBOOK_AI_HOME
  ?? join(process.env.HOME ?? '/Users/thibault', 'code', 'rulebook-ai');
const skillDirectory = join(rulebookRoot, 'skills', 'playwright-skill');
const officialTemplate = join(skillDirectory, 'templates', 'robb-agents.js');
const sourceTemplate = join(repositoryRoot, 'scripts', 'playwright', 'robb-agents.js');
const verifier = join(rulebookRoot, 'scripts', 'playwright-verify.sh');
const providerPaths = join(rulebookRoot, 'scripts', 'lib', 'provider-paths.sh');

for (const required of [sourceTemplate, verifier, providerPaths]) {
  if (!existsSync(required)) throw new Error(`Required Playwright validation file is missing: ${required}`);
}

// The macOS system Bash is 3.2 and does not support ${value,,}. Rulebook can be
// refreshed independently of this repository, so enforce the portable form at
// the validation boundary before invoking its official launcher.
const providerSource = readFileSync(providerPaths, 'utf8');
const portableProviderSource = providerSource.replace(
  'raw="${raw,,}"',
  'raw="$(printf \'%s\' "$raw" | tr \'[:upper:]\' \'[:lower:]\')"',
);
if (portableProviderSource !== providerSource) writeFileSync(providerPaths, portableProviderSource, 'utf8');

mkdirSync(dirname(officialTemplate), { recursive: true });
copyFileSync(sourceTemplate, officialTemplate);

const verification = Bun.spawn([verifier, 'robb-agents'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    PLAYWRIGHT_SKILL_DIR: skillDirectory,
    PLAYWRIGHT_AUTO_E2E: '0',
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(await verification.exited);
