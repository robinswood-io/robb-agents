import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalCwd = process.cwd();
const originalConfigDir = process.env.CRAFT_CONFIG_DIR;

const legacyBundledBashPatterns = [
  '^tree\\b',
  '^file\\b',
  '^less\\b',
  '^more\\b',
  '^bat\\b',
  '^markitdown\\b',
  '^pdf-tool\\s+(extract|info)\\b',
  '^xlsx-tool\\s+(read|info|export)\\b',
  '^doc-diff\\b',
  '^img-tool\\s+info\\b',
  '^docx-tool\\s+(info|extract)\\b',
  '^pptx-tool\\s+(info|extract)\\b',
  '^ical-tool\\s+(read|filter)\\b',
  '^rg\\b',
  '^rg\\b(?![^\\r\\n]*\\s--pre(?:=\\S*)?(?:\\s|$))',
  '^ag\\b',
  '^ack\\b',
  '^fd\\b',
  '^fzf\\b',
  '^git\\s+((-[A-Za-z]|--[a-z][-a-z]*)(\\s+[^\\s-][^\\s]*)?\\s+)*(status|log|diff|show|branch|tag|remote|stash\\s+list|describe|rev-parse|config\\s+--get|config\\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\\b',
  '^gh\\s+api\\b.*--method\\s+GET\\b',
  '^gh\\s+api\\b(?!.*--method)',
  '^npm\\s+(ls|list|view|info|show|outdated|audit|search|explain|why|config\\s+get|config\\s+list)\\b',
  '^pnpm\\s+(list|ls|why|outdated|audit)\\b',
  '^hostname\\b',
  '^date\\b',
  '^htop\\b',
  '^docker-compose\\s+(ps|logs|config|images|top|version)\\b',
  '^docker\\s+compose\\s+(ps|logs|config|images|top|version)\\b',
  '^kubectl\\s+(get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b',
  '^kubectl\\s+(?:get|describe|logs|top|explain|api-resources|api-versions|cluster-info|config\\s+view|config\\s+get-contexts|version)\\b(?![^\\r\\n]*\\s--output-directory(?:=\\S*)?(?:\\s|$))',
  '^sed\\s+-n\\b',
  '^sed\\s+-n\\b(?![^\\r\\n]*\\s(?:-i\\S*|--in-place(?:=\\S*)?)(?:\\s|$))',
  '^sort\\b',
  '^uniq\\b',
  '^(?:gawk|mawk|nawk|awk)\\b',
  '^yq\\b',
  '^xq\\b',
  '^xmllint\\b',
  '^python\\s+-m\\s+json\\.tool\\b',
  '^ip\\s+(addr|link|route|neigh)\\s*(show)?\\b',
  '^ifconfig\\b',
  '^node\\s+(--version|-v)\\b',
  '^npm\\s+(--version|-v)\\b',
  '^yarn\\s+(--version|-v)\\b',
  '^pnpm\\s+(--version|-v)\\b',
  '^bun\\s+(--version|-v)\\b',
  '^python\\s+(--version|-V)\\b',
  '^python3\\s+(--version|-V)\\b',
  '^ruby\\s+(--version|-v)\\b',
  '^go\\s+version\\b',
  '^rustc\\s+(--version|-V)\\b',
  '^cargo\\s+(--version|-V)\\b',
  '^java\\s+(-version|--version)\\b',
  '^dotnet\\s+--version\\b',
  '^php\\s+(--version|-v)\\b',
  '^perl\\s+(--version|-v)\\b',
  '^man\\b',
  '--help\\b',
  '-h\\b$',
] as const;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir;
});

describe('ensureDefaultPermissions migration', () => {
  it('merges new bundled defaults into existing installed file and preserves customizations', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'permissions-bundle-'));
    const tempConfig = mkdtempSync(join(tmpdir(), 'permissions-config-'));

    const bundledDir = join(tempRoot, 'resources', 'permissions');
    mkdirSync(bundledDir, { recursive: true });
    writeFileSync(
      join(bundledDir, 'default.json'),
      JSON.stringify({
        version: '2026-03-01',
        allowedBashPatterns: [
          { pattern: '^grep\\b', comment: 'Grep search' },
          { pattern: '^bun\\s+run\\s+typecheck\\b$', comment: 'Typecheck' },
          { pattern: '^rg\\b(?![^\\r\\n]*\\s--(?:pre|hostname-bin)(?:=\\S*)?(?:\\s|$))', comment: 'Hardened ripgrep' },
          { pattern: '^sort\\b(?![^\\r\\n]*\\s(?:-[^-\\s]*[oT]\\S*|--(?:output|temporary-directory|compress-program)(?:=\\S*)?)(?:\\s|$))', comment: 'Hardened sort' },
          { pattern: '^tree\\b(?![^\\r\\n]*\\s(?:-[^-\\s]*o\\S*|--output(?:=\\S*)?)(?:\\s|$))', comment: 'Hardened tree' },
        ],
        allowedMcpPatterns: ['search'],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        blockedCommandHints: [
          { command: 'printf', reason: 'printf blocked by default' },
          {
            command: 'sed',
            reason: 'sed is not allowlisted in Explore mode because its program can write files or execute commands even with -n.',
          },
          {
            command: 'awk',
            reason: 'awk is not allowlisted in Explore mode because its program can write files or execute external commands.',
          },
        ],
      }, null, 2)
    );

    const installedDir = join(tempConfig, 'permissions');
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, 'default.json'),
      JSON.stringify({
        version: '2026-02-01',
        allowedBashPatterns: [
          { pattern: '^grep\\b', comment: 'User existing pattern' },
          { pattern: '^custom-review\\b', comment: 'User customization' },
          ...legacyBundledBashPatterns.map(pattern => ({ pattern, comment: 'Legacy bundled pattern' })),
        ],
        allowedMcpPatterns: ['list'],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        blockedCommandHints: [
          { command: 'sed', reason: 'sed print-only policy', whenNotMatching: '^sed\\s+-n\\b' },
          {
            command: 'sed',
            reason: 'Only print-only sed is allowed in Explore mode by default.',
            whenNotMatching: '^sed\\s+-n\\b',
          },
          {
            command: 'awk',
            reason: 'awk is blocked when the command appears to execute external commands.',
          },
          {
            command: 'gawk',
            reason: 'gawk is blocked when the command appears to execute external commands.',
          },
          {
            command: 'mawk',
            reason: 'mawk is blocked when the command appears to execute external commands.',
          },
          {
            command: 'nawk',
            reason: 'nawk is blocked when the command appears to execute external commands.',
          },
        ],
      }, null, 2)
    );

    process.env.CRAFT_CONFIG_DIR = tempConfig;
    process.chdir(tempRoot);

    const mod = await import(`../permissions-config.ts?case=${Date.now()}`);
    mod.ensureDefaultPermissions();

    const merged = JSON.parse(readFileSync(join(installedDir, 'default.json'), 'utf-8'));

    expect(merged.version).toBe('2026-03-01');

    const bashPatterns = merged.allowedBashPatterns.map((p: string | { pattern: string }) =>
      typeof p === 'string' ? p : p.pattern
    );

    expect(bashPatterns).toContain('^custom-review\\b');
    expect(bashPatterns).toContain('^bun\\s+run\\s+typecheck\\b$');
    for (const legacyPattern of legacyBundledBashPatterns) {
      expect(bashPatterns).not.toContain(legacyPattern);
    }
    expect(bashPatterns.some((pattern: string) => pattern.startsWith('^sort\\b('))).toBe(true);
    expect(bashPatterns.some((pattern: string) => pattern.startsWith('^tree\\b('))).toBe(true);
    expect(bashPatterns.some((pattern: string) => pattern.startsWith('^rg\\b('))).toBe(true);
    expect(bashPatterns.filter((p: string) => p === '^grep\\b').length).toBe(1);

    const mcpPatterns = merged.allowedMcpPatterns as string[];
    expect(mcpPatterns).toContain('list');
    expect(mcpPatterns).toContain('search');

    const blockedCommandHints = merged.blockedCommandHints as Array<{ command: string; reason: string }>;
    expect(blockedCommandHints.some(h => h.command === 'printf')).toBe(true);
    expect(blockedCommandHints.some(h => h.reason === 'sed print-only policy')).toBe(true);
    expect(blockedCommandHints.some(h => h.reason.startsWith('Only print-only sed'))).toBe(false);
    expect(blockedCommandHints.some(h => h.reason.includes('appears to execute external commands'))).toBe(false);
    expect(blockedCommandHints.some(h => h.reason.startsWith('sed is not allowlisted'))).toBe(true);
    expect(blockedCommandHints.some(h => h.reason.startsWith('awk is not allowlisted'))).toBe(true);

    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
  });
});
