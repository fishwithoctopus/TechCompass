import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './tools.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function mcpKey(token) {
  return createHmac('sha256', token).update('techcompass-mcp-http-v1').digest('hex');
}
export async function handleMcpHttp(req, res, store, key) {
  const deny = (status, message) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
  const expectedHost = `127.0.0.1:${req.socket.localPort}`;
  if (![expectedHost, `localhost:${req.socket.localPort}`].includes(req.headers.host)) return deny(403, 'Invalid Host');
  if (req.headers.origin && ![`http://${expectedHost}`, `http://localhost:${req.socket.localPort}`].includes(req.headers.origin)) return deny(403, 'Invalid Origin');
  const auth = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny(401, 'Bearer token required');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return deny(405, 'Use Streamable HTTP POST; legacy SSE is not supported'); }
  let size = 0; const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) return deny(413, 'Request too large');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return deny(400, 'Invalid JSON'); }
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) deny(500, 'MCP request failed');
    else res.end();
  }
}
