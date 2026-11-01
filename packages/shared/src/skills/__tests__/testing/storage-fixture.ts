import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { loadAllSkills } from "../../storage.ts";



// The real global skills directory — we cannot mock this reliably.
export const REAL_GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');


// ============================================================
// Helpers
// ============================================================

/** Create a valid SKILL.md file in a skill directory */
export function createSkill(
  skillsDir: string,
  slug: string,
  opts: { name?: string; description?: string; globs?: string[]; content?: string; icon?: string; requiredSources?: string[] } = {}
): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });

  const name = opts.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const description = opts.description ?? `A ${slug} skill`;
  const content = opts.content ?? `Instructions for ${slug}`;
  const globs = opts.globs ? `\nglobs:\n${opts.globs.map(g => `  - "${g}"`).join('\n')}` : '';
  const icon = opts.icon ? `\nicon: "${opts.icon}"` : '';
  const requiredSources = opts.requiredSources
    ? `\nrequiredSources:\n${opts.requiredSources.map(source => `  - "${source}"`).join('\n')}`
    : '';

  const skillMd = `---
name: "${name}"
description: "${description}"${globs}${icon}${requiredSources}
---

${content}
`;
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  return skillDir;
}


/** Create an invalid SKILL.md (missing required fields) */
export function createInvalidSkill(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ntitle: "No name or description"\n---\nContent');
  return skillDir;
}


/** Create a directory without SKILL.md */
export function createEmptySkillDir(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}


/** Get the set of slugs currently in the real global skills directory */
export function getExistingGlobalSlugs(): Set<string> {
  const emptyWs = mkdtempSync(join(tmpdir(), 'skills-baseline-'));
  mkdirSync(join(emptyWs, 'skills'), { recursive: true });
  try {
    const skills = loadAllSkills(emptyWs);
    // These are all global skills since the workspace is empty
    return new Set(skills.map(s => s.slug));
  } finally {
    rmSync(emptyWs, { recursive: true, force: true });
  }
}
