import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChain } from './engine.js';
import { handleRpc } from './rpc.js';
import { platformSummary, listEvents } from '../platform/tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BKC_DB || path.join(__dirname, '..', 'data', 'bkc-mainnet.db');
const port = Number(process.env.BKC_RPC_PORT || 8899);

const chain = createChain({ dbPath, startProducer: true });

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/rpc')) {
      const body = await req.json();
      const calls = Array.isArray(body) ? body : [body];
      const out = calls.map((c) => {
        try {
          return { jsonrpc: '2.0', id: c.id ?? 1, result: handleRpc(chain, c.method, c.params || []) };
        } catch (err) {
          return { jsonrpc: '2.0', id: c.id ?? 1, error: { code: -32601, message: err.message } };
        }
      });
      return Response.json(Array.isArray(body) ? out : out[0]);
    }
    if (url.pathname === '/health') return Response.json({ status: 'ok', slot: chain.stats().slot });
    if (url.pathname === '/platform') return Response.json(platformSummary(chain.db));
    if (url.pathname === '/platform/events') {
      const type = url.searchParams.get('type');
      return Response.json(listEvents(chain.db, { type, limit: url.searchParams.get('limit') }));
    }
    return new Response('BKC JSON-RPC. POST /rpc', { status: 200 });
  },
});

console.log(`BKC node RPC http://localhost:${server.port}  db=${dbPath}`);
