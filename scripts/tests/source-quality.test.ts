import { describe, expect, it } from 'bun:test';
import { inspectSource, sourceArtifacts } from '../source-quality.ts';

describe('maintained-source quality contract', () => {
  it('rejects explicit any in test code, casts, generics and JSDoc types', () => {
    const content = 'const values: any[] = []; const result = values as any; type Result = Promise<any>;';
    expect(inspectSource('fixture.test.ts', content).filter(issue => issue.rule === 'no-explicit-any')).toHaveLength(3);
    expect(inspectSource('fixture.js', '/** @type {any} */ const result = 1;')).toContainEqual({
      file: 'fixture.js', rule: 'no-explicit-any', line: 1, actual: 1,
    });
  });
  it('distinguishes code from words in comments and strings', () => {
    expect(inspectSource('fixture.ts', '// any in prose\nconst value = "any";')).toEqual([]);
  });
  it('enforces the same 500-line limit on application code, tests and scripts', () => {
    for (const file of ['fixture.ts', 'fixture.test.ts', 'fixture.py', 'fixture.css', 'fixture.ps1']) {
      const comment = file.endsWith('.py') || file.endsWith('.ps1') ? '# line\n'
        : file.endsWith('.css') ? '/* line */\n' : '// line\n';
      expect(inspectSource(file, comment.repeat(500))).toEqual([]);
      expect(inspectSource(file, comment.repeat(501))).toContainEqual({ file, rule: 'max-lines', line: 501, actual: 501 });
    }
  });
  it('exempts only named upstream artifacts and historical rendered reports', () => {
    expect([...sourceArtifacts.keys()]).toEqual([
      'apps/electron/src/main/__tests__/fixtures/guacamole-keyboard-1.5.5.js',
      'audit/robb-0.11.6-2026-08-18/report.html',
      'docs/robinswood/reports/robb-agentic-audit-2026-08-27/report.html',
    ]);
  });
  it('rejects imported Python typing aliases in collections and return types', () => {
    const content = 'from typing import Any as Opaque\nvalue: dict[str, Opaque] = {}\ndef result() -> Opaque: ...\n';
    expect(inspectSource('fixture.py', content).map(issue => issue.line)).toEqual([2, 3]);
  });
  it('rejects qualified Python typing aliases', () => {
    expect(inspectSource('fixture.py', 'import typing as hints\nvalue: list[hints.Any] = []\n')).toEqual([
      { file: 'fixture.py', rule: 'no-explicit-any', line: 2, actual: 1 },
    ]);
  });
  it('checks forward annotations while preserving literal strings and annotation metadata', () => {
    const content = 'from typing import Any, Literal, Annotated\nclass Data:\n  value: "dict[str, Any]"\n  tag: Literal["Any"]\n  note: Annotated[int, "Any"]\n';
    expect(inspectSource('fixture.py', content).map(issue => issue.line)).toEqual([3]);
  });
  it('requires unused Python opaque typing imports to be removed', () => {
    expect(inspectSource('fixture.py', 'from typing import Any\nvalue: int = 1\n')).toEqual([
      { file: 'fixture.py', rule: 'no-explicit-any', line: 1, actual: 1 },
    ]);
  });
  it('preserves Python comments, strings and the any builtin', () => {
    expect(inspectSource('fixture.py', '# Any in prose\nword = "Any"\nresult = any([True])\n')).toEqual([]);
  });
  it('never executes Python application code while inspecting it', () => {
    expect(inspectSource('fixture.py', 'raise RuntimeError("must never execute")\n')).toEqual([]);
  });
});
