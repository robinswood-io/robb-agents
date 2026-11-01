import { describe, expect, it } from 'bun:test';
import { parseResponsesApiResults, responsesApiResponseSchema, responsesApiEventSchema } from './responses-api-parser.ts';

describe('Responses search wire boundaries', () => {
  it('preserves search text and citations alongside unconsumed upstream metadata', () => {
    const response = responsesApiResponseSchema.parse({
      id: 'qa-response', status: 'completed',
      output: [
        { type: 'web_search_call', action: { type: 'search', query: 'QA' } },
        { type: 'message', content: [{ type: 'output_text', text: 'Verified report', annotations: [
          { type: 'url_citation', title: 'Report', url: 'https://example.com/report', start_index: 0, end_index: 8 },
        ] }] },
      ],
    });
    expect(parseResponsesApiResults(response, 'QA', 3)).toEqual([
      { title: 'Report', url: 'https://example.com/report', description: 'Verified' },
    ]);
  });

  it('rejects malformed external content instead of coercing it into a search result', () => {
    for (const payload of [null, [], { output: {} }, { output_text: 42 },
      { output: [{ content: [{ text: 'Report', annotations: [{ url: 42 }] }] }] },
    ]) expect(responsesApiResponseSchema.safeParse(payload).success).toBe(false);
    expect(responsesApiEventSchema.safeParse({ type: 'response.output_item.done', item: { content: [{ text: 42 }] } }).success).toBe(false);
  });

  it('accepts a final SSE envelope without output so previously streamed items remain usable', () => {
    expect(responsesApiEventSchema.parse({ type: 'response.completed', response: { id: 'qa-response', status: 'completed' } }))
      .toEqual({ type: 'response.completed', response: {} });
  });
});
