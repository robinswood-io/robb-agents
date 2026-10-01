import { describe, expect, it } from 'bun:test';
import { buildApiRequestDebugMetadata } from '../api-tools.ts';

describe('API tool debug metadata', () => {
  it('retains header names and payload size without retaining credential values', () => {
    const bearerCredential = 'bearer-credential-value';
    const apiCredential = 'api-credential-value';
    const body = JSON.stringify({ action: 'health-check' });

    const queryCredential = 'query-credential-value';
    const queryValue = 'private-query-value';
    const metadata = buildApiRequestDebugMetadata({
      headers: {
        Authorization: `Bearer ${bearerCredential}`,
        'X-API-Key': apiCredential,
        'Content-Type': 'application/json',
      },
      body,
    }, `https://api.example.test/projects?api_key=${queryCredential}&search=${queryValue}`);
    const serialized = JSON.stringify(metadata);

    expect(metadata).toEqual({
      headerNames: ['authorization', 'content-type', 'x-api-key'],
      bodyLength: body.length,
      endpoint: 'https://api.example.test/projects',
      queryParameterNames: ['api_key', 'search'],
    });
    expect(serialized).not.toContain(bearerCredential);
    expect(serialized).not.toContain(apiCredential);
    expect(serialized).not.toContain(queryCredential);
    expect(serialized).not.toContain(queryValue);
  });
});
