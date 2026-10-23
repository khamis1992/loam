const http = require('node:http');
const path = require('node:path');
const { utilityProcess } = require('electron');
let child = null;
let childExited = true;
function health(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
// root: app root (may be inside app.asar). cwd: a real folder on disk.
async function start(root, port = 3002, cwd = root) {
  if (process.env.LOAM_DISABLE_BRIDGE === '1') return;
  const existing = await health(port);
  if (existing?.application === 'Loam MCP Bridge') return;
  const env = { ...process.env, LOAM_MCP_BRIDGE_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  child = utilityProcess.fork(path.join(root, 'addons', 'loam-bridge', 'server.mjs'), [], {
    cwd, env, stdio: 'pipe', serviceName: 'Loam MCP Bridge',
  });
  childExited = false;
  const owned = child;
  owned.on('exit', () => { if (child === owned) childExited = true; });
  owned.stdout?.on('data', data => process.stdout.write('[mcp-bridge] ' + data));
  owned.stderr?.on('data', data => process.stderr.write('[mcp-bridge] ' + data));
  owned.on('error', error => console.error('[mcp-bridge] ' + (error?.message || error?.type || error)));
  for (let i=0;i<80;i++) {
    if ((await health(port))?.application === 'Loam MCP Bridge') return;
    if (childExited) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.error('[mcp-bridge] unavailable; Loam will report disconnected MCP without blocking local tools.');
}
async function stop() {
  const owned=child; child=null; if (!owned || childExited) return;
  await new Promise(resolve => {
    const timer=setTimeout(()=>{try{owned.kill();}catch{}resolve();},5000);
    owned.once('exit',()=>{clearTimeout(timer);resolve();});
    try { owned.postMessage({type:'shutdown'}); } catch { try{owned.kill();}catch{} clearTimeout(timer); resolve(); }
  });
}
module.exports={start,stop};
