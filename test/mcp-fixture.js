import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    serverInfo: { name: 'redmaple-test', version: '1' }, capabilities: { tools: {} } };
  if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } }] };
  if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.arguments.text }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
