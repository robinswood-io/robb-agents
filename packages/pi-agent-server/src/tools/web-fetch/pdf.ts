import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { result } from './responses.ts';

// ============================================================
// Content-type handlers
// ============================================================

async function extractPdfText(buffer: Buffer): Promise<string> {
  // PDF.js owns its Node canvas primitives; keep the real worker available in bundles.
  if (!Reflect.get(globalThis, 'pdfjsWorker')) {
    Reflect.set(globalThis, 'pdfjsWorker', await import('pdfjs-dist/legacy/build/pdf.worker.mjs'));
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.filter(item => 'str' in item).map(item => item.str).join(' ');
      if (text.trim()) pages.push(`--- Page ${i} ---\n${text}`);
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

export async function handlePdf(
  buffer: Buffer,
  url: string,
  saveBinary: (buffer: Buffer, url: string, ext: string) => Promise<string>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  let savedPath: string;
  try {
    savedPath = await saveBinary(buffer, url, '.pdf');
  } catch {
    savedPath = '(failed to save)';
  }

  try {
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      return result(
        `PDF from ${url} (saved to ${savedPath})\n\nNo extractable text (likely scanned/image-based).`,
      );
    }
    return result(`PDF content from ${url} (saved to ${savedPath}):\n\n${text}`);
  } catch (err) {
    return result(
      `PDF from ${url} (saved to ${savedPath})\n\nFailed to extract text: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}
