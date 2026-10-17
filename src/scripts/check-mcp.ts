import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ToolRegistry } from '../tools/registry.js';
import { registerMcpTools } from '../tools/mcp.js';

const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = (reservation.address() as net.AddressInfo).port;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mcp-check-'));
await new Promise<void>(resolve => reservation.close(() => resolve()));
const bridge = spawn(process.execPath, ['addons/loam-bridge/server.mjs'], {
  env: { ...process.env, LOAM_DATA_DIR: dataDir, LOAM_MCP_BRIDGE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let diagnostics = '';
bridge.stderr!.on('data', chunk => { diagnostics += String(chunk).slice(0, 500); });
bridge.stdout!.resume();
let mcp: Awaited<ReturnType<typeof registerMcpTools>> | undefined;
try {
  let health: any;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited: ${diagnostics}`);
    try { health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal(health?.application, 'Loam MCP Bridge');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const registry = new ToolRegistry();
  mcp = await registerMcpTools(registry, {
    bridge: { transport: 'http', url: `http://127.0.0.1:${port}/mcp` },
    invalid: { transport: 'http', url: `http://127.0.0.1:${port}/not-mcp` },
  }, process.cwd());
  assert.deepEqual(mcp.servers, ['bridge']);
  const statuses = await mcp.status();
  assert.equal(statuses.find(s => s.name === 'bridge')?.connected, true);
  assert.equal(statuses.find(s => s.name === 'invalid')?.connected, false);
  assert.equal(registry.names().length, health.tools);
  assert.equal((await mcp.callTool('bridge', 'nonexistent', {})).ok, false);
  const probes = [['ruflo', 'ruflo__system_status'], ['agentdb', 'agentdb__db_stats']] as const;
  for (const [backend, tool] of probes) {
    if (!health.backends.includes(backend)) { console.log(`UNVERIFIED ${backend}: not connected`); continue; }
    const result = await mcp.callTool('bridge', tool, {});
    assert.equal(result.ok, true, `${tool}: ${result.content}`);
    assert.ok(result.content.length > 0);
    console.log(`PASS ${tool}: read-only real backend call`);
  }
  assert.equal(registry.forAskMode().names().some(name => name.startsWith('mcp__')), false);
  console.log(`PASS MCP initialize, pagination/list (${health.tools}), ping, call routing, error, origin guard, Ask isolation`);
} finally {
  await mcp?.close();
  if (bridge.connected) bridge.send({ type: 'shutdown' });
  if (bridge.exitCode === null) await Promise.race([once(bridge, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (bridge.exitCode === null) bridge.kill();
}
