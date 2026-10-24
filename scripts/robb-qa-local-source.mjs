// Read-only QA fixture: no filesystem writes, network calls or business data.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'robb-autonomy-qa', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await new Promise(resolve => setTimeout(resolve, 4_000));
  return { tools: [{
    name: 'qa_sum',
    description: 'Read-only synthetic QA arithmetic; returns a+b without side effects.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }] };
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (name !== 'qa_sum' || typeof args?.a !== 'number' || typeof args?.b !== 'number') throw new Error('Only qa_sum with two numeric arguments is available.');
  return { content: [{ type: 'text', text: JSON.stringify({ sum: args.a + args.b, fixture: 'synthetic-local-qa' }) }] };
});
await server.connect(new StdioServerTransport());
