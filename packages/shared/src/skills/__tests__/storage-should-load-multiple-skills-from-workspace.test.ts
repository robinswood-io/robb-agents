/**
 * Tests for Skills Storage
 *
 * Verifies the three-tier skill loading system:
 * 1. Global skills: ~/.agents/skills/ (lowest priority)
 * 2. Workspace skills: {workspaceRoot}/skills/ (medium priority)
 * 3. Project skills: {projectRoot}/.agents/skills/ (highest priority)
 *
 * Uses real temp directories to test actual filesystem operations.
 *
 * Note: The global skills directory (~/.agents/skills/) is a module-level constant
 * that cannot be mocked reliably when tests run in parallel with other test files.
 * The loadAllSkills tests account for any pre-existing global skills by capturing a
 * baseline count and validating relative to it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadWorkspaceSkills } from "../storage.ts";
import { createEmptySkillDir, createInvalidSkill, createSkill } from "./testing/storage-fixture.ts";

// ============================================================
// Temp Directory Setup
// ============================================================

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;

// ============================================================
// Test Setup
// ============================================================

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');

  // Create base directories
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});
afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('loadWorkspaceSkills', () => {
  it('should load multiple skills from workspace', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'commit');
    createSkill(skillsDir, 'review');
    createSkill(skillsDir, 'deploy');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(3);
    const slugs = skills.map(s => s.slug).sort();
    expect(slugs).toEqual(['commit', 'deploy', 'review']);
    // All should be workspace source
    for (const skill of skills) {
      expect(skill.source).toBe('workspace');
    }
  });

  it('should return empty array for empty skills directory', () => {
    // workspaceRoot/skills/ exists but has no subdirectories
    const skills = loadWorkspaceSkills(workspaceRoot);
    expect(skills).toEqual([]);
  });

  it('should return empty array for non-existent workspace root', () => {
    const skills = loadWorkspaceSkills(join(tempDir, 'nonexistent'));
    expect(skills).toEqual([]);
  });

  it('should skip directories without SKILL.md', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid-skill');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('valid-skill');
  });

  it('should skip invalid SKILL.md files', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid');
    createInvalidSkill(skillsDir, 'invalid');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('valid');
  });

  it('should skip non-directory entries', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'real-skill');
    // Create a plain file in the skills directory (not a subdirectory)
    writeFileSync(join(skillsDir, 'readme.txt'), 'This is not a skill');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('real-skill');
  });

  it('should load symlinked skill directories from workspace', () => {
    if (process.platform === 'win32') {
      return;
    }

    const skillsDir = join(workspaceRoot, 'skills');
    const realSkillsDir = join(tempDir, 'real-skills');
    mkdirSync(realSkillsDir, { recursive: true });
    createSkill(realSkillsDir, 'shared-skill', {
      name: 'Shared Skill',
      description: 'Loaded through a symlink',
    });

    symlinkSync(
      join(realSkillsDir, 'shared-skill'),
      join(skillsDir, 'shared-skill'),
      'dir'
    );

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills.map(skill => skill.slug)).toContain('shared-skill');
    const skill = skills.find(skill => skill.slug === 'shared-skill');
    expect(skill!.metadata.name).toBe('Shared Skill');
  });

  it('should ignore broken symlinked skill directories', () => {
    if (process.platform === 'win32') {
      return;
    }

    const skillsDir = join(workspaceRoot, 'skills');
    symlinkSync(
      join(tempDir, 'missing-target'),
      join(skillsDir, 'broken-skill'),
      'dir'
    );

    expect(() => loadWorkspaceSkills(workspaceRoot)).not.toThrow();
    expect(loadWorkspaceSkills(workspaceRoot)).toEqual([]);
  });
});
