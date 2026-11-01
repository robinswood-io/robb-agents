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
import { listSkillSlugs } from "../storage.ts";
import { createEmptySkillDir, createSkill } from "./testing/storage-fixture.ts";

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

describe('listSkillSlugs', () => {
  it('should list all valid skill slugs', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'alpha');
    createSkill(skillsDir, 'beta');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs.sort()).toEqual(['alpha', 'beta']);
  });

  it('should return empty array for empty skills directory', () => {
    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs).toEqual([]);
  });

  it('should return empty array for non-existent workspace', () => {
    const slugs = listSkillSlugs(join(tempDir, 'nonexistent'));
    expect(slugs).toEqual([]);
  });

  it('should include symlinked skill directories in listSkillSlugs', () => {
    if (process.platform === 'win32') {
      return;
    }

    const skillsDir = join(workspaceRoot, 'skills');
    const realSkillDir = join(tempDir, 'real-shared-skill');
    mkdirSync(realSkillDir, { recursive: true });
    writeFileSync(join(realSkillDir, 'SKILL.md'), `---
name: "Shared Skill"
description: "Loaded through a symlink"
---
Instructions
`);

    symlinkSync(realSkillDir, join(skillsDir, 'shared-skill'), 'dir');

    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs).toContain('shared-skill');
  });
});
