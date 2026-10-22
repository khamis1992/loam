const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Only release artifacts from the user's local update channel are served.
async function startLocalUpdates(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const server = http.createServer((req, res) => {
    const name = (req.url || '').split('?')[0].slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !/^(latest\.yml|Loam-Setup-[\d.]+\.exe(?:\.blockmap)?)$/.test(name)) {
      res.writeHead(404).end(); return;
    }
    const file = path.join(directory, name);
    let stat; try { stat = fs.statSync(file); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);stream.on('error', () => res.destroy());res.on('close', () => stream.destroy());stream.pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
module.exports = { startLocalUpdates };
