import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

export interface SourceQualityIssue {
  file: string;
  rule: 'max-lines' | 'no-explicit-any';
  line: number;
  actual: number;
}

// Unmodified third-party fixtures and historical rendered audit reports are
// deliverables, not maintained source. Authored fixtures and tests remain covered.
export const sourceArtifacts = new Map([
  ['apps/electron/src/main/__tests__/fixtures/guacamole-keyboard-1.5.5.js', 'Unmodified upstream keyboard fixture'],
  ['audit/robb-0.11.6-2026-08-18/report.html', 'Historical rendered audit report'],
  ['docs/robinswood/reports/robb-agentic-audit-2026-08-27/report.html', 'Historical rendered audit report'],
]);
const codeExtension = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|ps1|css|scss|html|sql|ya?ml|toml)$/;
const typedExtension = /\.[cm]?[jt]sx?$/;

function inspectPythonSources(sources: readonly { file: string; content: string }[]): SourceQualityIssue[] {
  if (!sources.length) return [];
  const python = process.env["ROBB_PYTHON"] ?? (process.platform === 'win32' ? 'python' : 'python3');
  const output = execFileSync(python, ['-I', resolve(import.meta.dir, 'source-quality-python.py')], {
    input: JSON.stringify(sources), encoding: 'utf8',
  });
  return JSON.parse(output) as SourceQualityIssue[];
}

export function inspectSource(file: string, content: string, inspectPythonTypes = true): SourceQualityIssue[] {
  const issues: SourceQualityIssue[] = [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 500) issues.push({ file, rule: 'max-lines', line: 501, actual: lines.length });
  if (inspectPythonTypes && file.endsWith('.py')) issues.push(...inspectPythonSources([{ file, content }]));
  if (!typedExtension.test(file)) return issues;

  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const visited = new Set<ts.Node>();
  function visit(node: ts.Node): void {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      issues.push({ file, rule: 'no-explicit-any',
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, actual: 1 });
    }
    ts.forEachChild(node, visit);
    for (const tag of ts.getJSDocTags(node)) visit(tag);
  }
  visit(source);
  return issues;
}

export function inspectRepository(repo: string) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repo, encoding: 'utf8' }).split('\0'))]
    .filter(file => codeExtension.test(file) && !sourceArtifacts.has(file) && existsSync(resolve(repo, file)))
    .sort();
  if (!files.length) throw new Error('No maintained source files found');
  const sources = files.map(file => ({ file, content: readFileSync(resolve(repo, file), 'utf8') }));
  const issues = sources.flatMap(({ file, content }) => inspectSource(file, content, false));
  issues.push(...inspectPythonSources(sources.filter(source => source.file.endsWith('.py'))));
  issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { files: files.length, maxLines: 500,
    sourceArtifacts: Object.fromEntries(sourceArtifacts),
    issues };
}

if (import.meta.main) {
  const report = inspectRepository(resolve(import.meta.dir, '..'));
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex >= 0) {
    const destination = process.argv[jsonIndex + 1];
    if (!destination) throw new Error('--json requires an output path');
    writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  }
  for (const issue of report.issues.slice(0, 30)) {
    console.error(`${issue.file}:${issue.line}: ${issue.rule} (${issue.actual})`);
  }
  const longFiles = report.issues.filter(issue => issue.rule === 'max-lines').length;
  const explicitAny = report.issues.filter(issue => issue.rule === 'no-explicit-any').length;
  console.log(`${report.files} maintained files; ${longFiles} over 500 lines; ${explicitAny} explicit any`);
  process.exitCode = report.issues.length ? 1 : 0;
}
