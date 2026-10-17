import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Backend installations are optional and remain outside Loam's isolated task tools.
const root = process.env.LOAM_RUFLO_ROOT || path.join(os.homedir(), 'ruflo-opencode');
const port = Number(process.env.LOAM_MCP_BRIDGE_PORT || 3002);
const dataDir = path.join(process.env.LOAM_DATA_DIR || path.join(process.cwd(), 'data'), 'mcp-bridge');
fs.mkdirSync(dataDir, { recursive: true });
const clients = new Map();
const catalog = new Map();
const unavailable = [];
for (const [name, entry] of [
  ['ruflo', path.join(root, 'v3', '@claude-flow', 'cli', 'bin', 'mcp-server.js')],
  ['agentdb', path.join(root, 'node_modules', 'agentdb', 'dist', 'src', 'mcp', 'agentdb-mcp-server.js')],
]) {
  if (!fs.existsSync(entry)) { unavailable.push({ name, reason: 'not-installed' }); continue; }
  const client = new Client({ name: 'loam-bridge', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: dataDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTDB_PATH: path.join(dataDir, 'agentdb.db') }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 15000 });
    if (name === 'agentdb') {
      // Some distributions omit SQL assets and silently skip their startup schema.
      // The built-in idempotent initializer repairs only Loam's dedicated bridge DB.
      const initialized = await client.callTool({ name: 'agentdb_init', arguments: { reset: false } }, undefined, { timeout: 15000 });
      if (initialized.isError) throw new Error('database initialization failed');
    }
    let cursor;
    const tools = [];
    const cursors = new Set();
    do {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('pagination cycle');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Always namespace: routing is based on the actual listed owner, never a guessed prefix.
    for (const tool of tools) catalog.set(`${name}__${tool.name}`, { ...tool, name: `${name}__${tool.name}`, owner: name, originalName: tool.name });
    clients.set(name, client);
    client.onclose = () => {
      clients.delete(name);
      for (const [key, tool] of catalog) if (tool.owner === name) catalog.delete(key);
      unavailable.push({ name, reason: 'disconnected' });
    };
  } catch {
    unavailable.push({ name, reason: 'initialization-failed' });
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

const connections = new Set();
const httpServer = http.createServer(async (req, res) => {
  // Do not grant browser pages cross-origin access to local administrative tools.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host || '') || req.headers.origin) {
    res.writeHead(403).end('Forbidden'); return;
  }
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      application: 'Loam MCP Bridge', service: 'loam-mcp-bridge', status: clients.size ? 'ready' : 'unavailable', backendCount: clients.size, backends: [...clients.keys()], tools: catalog.size, unavailable,
    })); return;
  }
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
  const server = new Server({ name: 'loam-mcp-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...catalog.values()].map(({ owner, originalName, ...tool }) => tool) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = catalog.get(params.name);
    const client = tool && clients.get(tool.owner);
    if (!tool || !client) return { isError: true, content: [{ type: 'text', text: 'MCP tool unavailable' }] };
    try { return await client.callTool({ name: tool.originalName, arguments: params.arguments || {} }, undefined, { timeout: 30000 }); }
    catch { return { isError: true, content: [{ type: 'text', text: 'MCP backend call failed' }] }; }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  connections.add(server);
  res.on('close', () => { connections.delete(server); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res); }
  catch { if (!res.headersSent) res.writeHead(500).end(); }
});
httpServer.on('error', async (error) => {
  console.error(`Loam MCP bridge: ${error.code || 'listen-failed'}`);
  await shutdown(); process.exitCode = 1;
});
httpServer.listen(port, '127.0.0.1', () => console.log(`Loam MCP bridge ready at http://127.0.0.1:${port}/mcp (${catalog.size} tools)`));
async function shutdown() {
  httpServer.close();
  httpServer.closeAllConnections();
  await Promise.allSettled([...connections, ...clients.values()].map(client => client.close()));
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await shutdown(); process.exit(0); });
process.on('message', async (message) => { if (message?.type === 'shutdown') { await shutdown(); process.exit(0); } });
process.on('disconnect', async () => { await shutdown(); process.exit(0); });
