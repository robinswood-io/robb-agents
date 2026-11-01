import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebFetchTool } from './web-fetch.ts';

const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function textPdf(text: string) {
  const stream = `BT /F1 12 Tf 1 0 0 1 72 720 Tm (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function fixture(bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'web-fetch-pdf-'));
  roots.push(root);
  globalThis.fetch = Object.assign(async () => new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/pdf' },
  }), { preconnect: originalFetch.preconnect });
  return { root, tool: createWebFetchTool(() => root) };
}

describe('web_fetch native PDF pipeline', () => {
  it('saves the exact PDF and extracts its text with a working native matrix', async () => {
    const bytes = textPdf('ROBB OFFLINE PDF COMPLETE');
    const { root, tool } = fixture(bytes);
    const output = await tool.execute('pdf-fixture', { url: 'https://1.1.1.1/qa.pdf' });
    const text = output.content.find(item => item.type === 'text')?.text;
    expect(text).toContain('--- Page 1 ---');
    expect(text).toContain('ROBB OFFLINE PDF COMPLETE');
    const files = readdirSync(join(root, 'long_responses'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, 'long_responses', files[0]!))).toEqual(bytes);
    const point = new DOMMatrix([2, 0, 0, 3, 4, 5]).transformPoint({ x: 2, y: 3 });
    expect({ x: point.x, y: point.y }).toEqual({ x: 8, y: 14 });
  });

  it('reports an invalid PDF explicitly while preserving the downloaded bytes', async () => {
    const bytes = Buffer.from('not a valid PDF');
    const { root, tool } = fixture(bytes);
    const output = await tool.execute('invalid-pdf-fixture', { url: 'https://1.1.1.1/invalid.pdf' });
    expect(output.content.find(item => item.type === 'text')?.text).toContain('Failed to extract text:');
    const files = readdirSync(join(root, 'long_responses'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, 'long_responses', files[0]!))).toEqual(bytes);
  });
});
