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
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllSkills } from "../storage.ts";
import { createSkill, getExistingGlobalSlugs } from "./testing/storage-fixture.ts";

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

describe('loadAllSkills', () => {
  const getWorkspaceSkillsDir = () => join(workspaceRoot, 'skills');

  const getProjectSkillsDir = () => join(projectRoot, '.agents', 'skills');

  // Use unique slugs that won't collide with real global skills
  const TEST_PREFIX = '_test_storage_';

  it('should load workspace and project skills alongside any existing global skills', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}ws`, { name: 'Workspace Skill', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}proj`, { name: 'Project Skill', description: 'From project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Should have baseline global skills + our 2 test skills
    expect(skills.length).toBe(baselineGlobal.size + 2);

    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws`);
    const projSkill = skills.find(s => s.slug === `${TEST_PREFIX}proj`);

    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');

    expect(projSkill).toBeDefined();
    expect(projSkill!.source).toBe('project');

    // All baseline global skills should still be present with source 'global'
    for (const globalSlug of baselineGlobal) {
      const skill = skills.find(s => s.slug === globalSlug);
      expect(skill).toBeDefined();
      expect(skill!.source).toBe('global');
    }
  });

  it('should override global skills with workspace skills when slug matches', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    // Only test override if there are actually global skills to override
    if (baselineGlobal.size === 0) {
      // No global skills — just verify workspace skills load
      const wsDir = getWorkspaceSkillsDir();
      createSkill(wsDir, `${TEST_PREFIX}ws_only`, { name: 'WS Only', description: 'WS only skill' });
      const skills = loadAllSkills(workspaceRoot);
      expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_only`)).toBeDefined();
      return;
    }

    // Override one of the existing global skills with a workspace skill
    const globalSlugToOverride = [...baselineGlobal][0]!;
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, globalSlugToOverride, {
      name: 'Workspace Override',
      description: 'This overrides the global skill',
    });

    const skills = loadAllSkills(workspaceRoot);

    const overridden = skills.find(s => s.slug === globalSlugToOverride);
    expect(overridden).toBeDefined();
    expect(overridden!.source).toBe('workspace');
    expect(overridden!.metadata.name).toBe('Workspace Override');

    // Total count should be same as baseline (overridden, not added)
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should override workspace skills with project skills (same slug)', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}deploy`, { name: 'Workspace Deploy', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}deploy`, { name: 'Project Deploy', description: 'Project version' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Only 1 skill for this slug (project overrides workspace), plus baseline globals
    expect(skills.length).toBe(baselineGlobal.size + 1);
    const deploy = skills.find(s => s.slug === `${TEST_PREFIX}deploy`);
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe('project');
    expect(deploy!.metadata.name).toBe('Project Deploy');
    expect(deploy!.metadata.description).toBe('Project version');
  });

  it('should handle full three-tier override: project > workspace > global', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug at workspace and project tiers
    createSkill(wsDir, `${TEST_PREFIX}shared`, { name: 'Workspace', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}shared`, { name: 'Project', description: 'Project version' });

    // Unique skills at each controllable tier
    createSkill(wsDir, `${TEST_PREFIX}only_ws`, { description: 'Only in workspace' });
    createSkill(projDir, `${TEST_PREFIX}only_proj`, { description: 'Only in project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Shared skill should be project version (highest priority)
    const shared = skills.find(s => s.slug === `${TEST_PREFIX}shared`);
    expect(shared).toBeDefined();
    expect(shared!.source).toBe('project');
    expect(shared!.metadata.name).toBe('Project');

    // Unique skills should keep their sources
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_ws`)!.source).toBe('workspace');
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_proj`)!.source).toBe('project');

    // Total: baseline globals + shared (1, deduplicated) + only_ws + only_proj = baseline + 3
    expect(skills.length).toBe(baselineGlobal.size + 3);
  });

  it('should handle missing project directory gracefully', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // Pass a non-existent project root
    const skills = loadAllSkills(workspaceRoot, join(tempDir, 'nonexistent-project'));

    expect(skills.length).toBe(baselineGlobal.size + 1);
    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`);
    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');
  });

  it('should skip project tier when projectRoot is undefined', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });
    createSkill(projDir, `${TEST_PREFIX}project_only`);

    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // No projectRoot passed — project tier should be skipped
    const skills = loadAllSkills(workspaceRoot);

    // Should NOT contain the project-only skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}project_only`)).toBeUndefined();
    // Should contain the workspace skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`)).toBeDefined();
    expect(skills.length).toBe(baselineGlobal.size + 1);
  });

  it('should return only global skills when workspace and project are empty', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    const skills = loadAllSkills(workspaceRoot);

    // With empty workspace and no project, only global skills remain
    expect(skills.length).toBe(baselineGlobal.size);
    for (const skill of skills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should correctly assign source for workspace and project tiers', () => {
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}w1`);
    createSkill(wsDir, `${TEST_PREFIX}w2`);
    createSkill(projDir, `${TEST_PREFIX}p1`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills.filter(s => s.source === 'workspace')).toHaveLength(2);
    expect(testSkills.filter(s => s.source === 'project')).toHaveLength(1);

    // Global skills should all have source 'global'
    const globalSkills = skills.filter(s => !s.slug.startsWith(TEST_PREFIX));
    for (const skill of globalSkills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should deduplicate by slug across workspace and project tiers', () => {
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug in workspace and project — only project should remain
    createSkill(wsDir, `${TEST_PREFIX}dup`, { name: 'WS Dup', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}dup`, { name: 'Proj Dup', description: 'From project' });
    // Unique skills
    createSkill(wsDir, `${TEST_PREFIX}unique_ws`);
    createSkill(projDir, `${TEST_PREFIX}unique_proj`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // 3 test skills (dup deduplicated to 1 + 2 uniques) + baseline
    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills).toHaveLength(3);

    const dup = skills.find(s => s.slug === `${TEST_PREFIX}dup`);
    expect(dup!.source).toBe('project');
    expect(dup!.metadata.name).toBe('Proj Dup');
  });
});
