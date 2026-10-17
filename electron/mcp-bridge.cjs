const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
let child = null;
function health(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function start(root, port = 3002) {
  if (process.env.LOAM_DISABLE_BRIDGE === '1') return;
  const existing = await health(port);
  if (existing?.application === 'Loam MCP Bridge') return;
  child = spawn(process.execPath, [path.join(root, 'addons', 'loam-bridge', 'server.mjs')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOAM_MCP_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', data => process.stdout.write('[mcp-bridge] ' + data));
  child.stderr.on('data', data => process.stderr.write('[mcp-bridge] ' + data));
  child.on('error', error => console.error('[mcp-bridge] ' + error.message));
  for (let i=0;i<80;i++) {
    if ((await health(port))?.application === 'Loam MCP Bridge') return;
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.error('[mcp-bridge] unavailable; Loam will report disconnected MCP without blocking local tools.');
}
async function stop() {
  const owned=child; child=null; if (!owned || owned.exitCode !== null) return;
  await new Promise(resolve => {
    const timer=setTimeout(()=>{try{owned.kill();}catch{}resolve();},5000);
    owned.once('exit',()=>{clearTimeout(timer);resolve();});
    try { if (owned.connected) owned.send({type:'shutdown'}); else owned.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}
module.exports={start,stop};
