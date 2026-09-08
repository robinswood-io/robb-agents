import { describe, expect, test } from 'bun:test';
import { validateMcpUrl } from './url-validator.ts';

describe('local MCP URL validation', () => {
  test('accepts documented link identifiers without provider credentials', async () => {
    for (const id of ['DSdsfdsjkf34235', 'ABC123', 'xY9-abc_123']) {
      expect(await validateMcpUrl(`https://mcp.craft.do/links/${id}/mcp`)).toEqual({ valid: true });
    }
  });

  test('rejects credential, host, protocol and path confusion', async () => {
    for (const url of [
      'https://mcp.craft.do.evil.invalid/links/abc/mcp',
      'https://user:pass@mcp.craft.do/links/abc/mcp',
      'https://mcp.craft.do@evil.invalid/links/abc/mcp',
      'http://mcp.craft.do/links/abc/mcp',
      'https://mcp.craft.do/links/abc%2fextra/mcp',
      'https://mcp.craft.do/links/abc/mcp?redirect=elsewhere',
      'https://mcp.craft.do/links/abc/mcp#fragment',
      'https://mcp.craft.do/links/abc',
      'Please validate https://mcp.craft.do/links/abc/mcp',
      'https://mcp.craft.do:444/links/abc/mcp',
      '',
    ]) {
      expect((await validateMcpUrl(url)).valid).toBe(false);
    }
  });
});
