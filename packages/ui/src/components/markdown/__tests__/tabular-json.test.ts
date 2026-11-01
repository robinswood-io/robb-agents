import { describe, expect, it } from 'bun:test';
import { parseDatatableSpec, parseTabularFile } from '../datatable-values.tsx';

describe('table and spreadsheet JSON boundaries', () => {
  it('preserves rows, falsy cell values and both display metadata formats', () => {
    const parsed = parseTabularFile('{"title":"Report","filename":"report.xlsx","sheetName":"QA","columns":[{"key":"amount","type":"currency"}],"rows":[{"amount":0,"approved":false,"note":null}]}');
    expect(parsed).toEqual({
      title: 'Report', filename: 'report.xlsx', sheetName: 'QA',
      columns: [{ key: 'amount', label: 'amount', type: 'currency' }],
      rows: [{ amount: 0, approved: false, note: null }],
    });
  });

  it('accepts a file containing only rows without inventing columns', () => {
    expect(parseTabularFile('[{"amount":7}]')).toEqual({ rows: [{ amount: 7 }], columns: [] });
    expect(parseTabularFile('[]')).toEqual({ rows: [], columns: [] });
  });

  it('rejects invalid file shapes rather than displaying an empty successful preview', () => {
    for (const input of ['{}', 'null', '{"rows":{}}', '[null]', '[{"amount":7},42]', '{"rows":[],"columns":[{}]}']) {
      expect(parseTabularFile(input)).toBeNull();
    }
  });

  it('supports inline data and file references while retaining spreadsheet formulas', () => {
    expect(parseDatatableSpec('{"src":"data/report.json","title":"Report"}'))
      .toEqual({ src: 'data/report.json', title: 'Report' });
    expect(parseDatatableSpec('{"columns":[{"key":"total","label":"Total","type":"formula"}],"rows":[{"total":"=SUM(A1:A3)"}]}'))
      .toEqual({ columns: [{ key: 'total', label: 'Total', type: 'formula' }], rows: [{ total: '=SUM(A1:A3)' }] });
  });

  it('falls back to plain cell formatting for unknown optional formats without dropping data', () => {
    expect(parseDatatableSpec('{"columns":[{"key":"amount","type":"future-format"}],"rows":[{"amount":7}]}'))
      .toEqual({ columns: [{ key: 'amount', label: 'amount' }], rows: [{ amount: 7 }] });
    expect(parseDatatableSpec('{"columns":[],"rows":[7]}')).toBeNull();
  });
});
