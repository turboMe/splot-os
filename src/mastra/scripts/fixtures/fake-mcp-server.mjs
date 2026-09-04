#!/usr/bin/env node
/**
 * Fake MCP server — fixture for e2e:cgp-discover-attach (Etap 7).
 *
 * A REAL stdio MCP server (via the official SDK) exposing one echo tool, so the
 * CGP e2e exercises the genuine connect → listTools → invoke path instead of a
 * mock. It also reports whether it received a real or mocked secret, which lets
 * the test prove sandbox isolation end-to-end.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-capability-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the given text, plus what the server sees in FAKE_SECRET.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const text = String(request.params.arguments?.text ?? '');
  const seenSecret = process.env.FAKE_SECRET ?? '(unset)';
  return {
    content: [{ type: 'text', text: JSON.stringify({ echo: text, seenSecret }) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
