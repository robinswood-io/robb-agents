import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { HtmlValidate } from 'html-validate';
import { printParseErrorCode, visit, type ParseErrorCode } from 'jsonc-parser';
import stylelint from 'stylelint';
import { LineCounter, parseDocument } from 'yaml';
import { sourceArtifacts } from './source-quality';

export interface FormatIssue { file: string; line: number; rule: string; message: string }
const supported = new Set(['.css', '.html', '.json', '.yaml', '.yml']);
const html = new HtmlValidate({ root: true, extends: ['html-validate:recommended'] });
const cssConfig: stylelint.Config = {
  extends: ['stylelint-config-recommended'],
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
  reportDescriptionlessDisables: true,
  rules: {
    // These are Tailwind 4 compiler directives, checked by the production build.
    'at-rule-no-unknown': [true, { ignoreAtRules: ['custom-variant', 'plugin', 'source', 'theme'] }],
  },
};

export function formatFiles(repo: string): string[] {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repo, encoding: 'utf8' }).split('\0'))]
    .filter(file => supported.has(extname(file)) && !sourceArtifacts.has(file) && existsSync(resolve(repo, file)))
    .sort();
}

export function inspectJson(file: string, content: string): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const keys: Set<string>[] = [];
  // TypeScript configurations explicitly use the compiler's JSON-with-comments dialect.
  const jsonc = /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(file);
  visit(content, {
    onObjectBegin: () => { keys.push(new Set()); },
    onObjectEnd: () => { keys.pop(); },
    onObjectProperty: (name, _offset, _length, line) => {
      const current = keys.at(-1);
      if (current?.has(name)) issues.push({ file, line: line + 1, rule: 'json/duplicate-key', message: name });
      current?.add(name);
    },
    onError: (error: ParseErrorCode, _offset, _length, line) => {
      issues.push({ file, line: line + 1, rule: 'json/syntax', message: printParseErrorCode(error) });
    },
  }, { allowTrailingComma: jsonc, disallowComments: !jsonc, allowEmptyContent: false });
  return issues;
}

export async function inspectFormat(file: string, content: string): Promise<FormatIssue[]> {
  const extension = extname(file);
  if (extension === '.json') return inspectJson(file, content);
  if (extension === '.yaml' || extension === '.yml') {
    const lineCounter = new LineCounter();
    const document = parseDocument(content, { lineCounter, uniqueKeys: true, strict: true });
    return [...document.errors, ...document.warnings].map(error => ({
      file, line: lineCounter.linePos(error.pos[0]).line, rule: `yaml/${error.code}`, message: error.message,
    }));
  }
  if (extension === '.html') {
    const report = await html.validateString(content, file);
    return report.results.flatMap(result => result.messages.map(message => ({
      file, line: message.line, rule: `html/${message.ruleId}`, message: message.message,
    })));
  }
  if (extension === '.css') {
    const report = await stylelint.lint({ code: content, codeFilename: resolve(file), config: cssConfig });
    return report.results.flatMap(result => [
      ...result.warnings.map(warning => ({ file, line: warning.line ?? 1,
        rule: `css/${warning.rule}`, message: warning.text })),
      ...result.parseErrors.map(error => ({ file, line: error.line ?? 1,
        rule: 'css/syntax', message: error.text })),
      ...result.invalidOptionWarnings.map(error => ({ file, line: 1,
        rule: 'css/config', message: error.text })),
    ]);
  }
  throw new Error(`Unsupported format: ${file}`);
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, '..');
  const files = formatFiles(repo);
  let errors = 0;
  for (const file of files) {
    for (const issue of await inspectFormat(file, readFileSync(resolve(repo, file), 'utf8'))) {
      console.error(`${issue.file}:${issue.line} ${issue.rule}: ${issue.message}`);
      errors += 1;
    }
  }
  console.log(`${files.length} CSS/HTML/JSON/YAML files; ${errors} diagnostics`);
  process.exitCode = errors ? 1 : 0;
}
