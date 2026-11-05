const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Only release artifacts from the user's local update channel are served.
async function startLocalUpdates(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const server = http.createServer((req, res) => {
    const name = (req.url || '').split('?')[0].slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !/^(latest\.yml|(?:Loam|manus-local)-Setup-[\d.]+\.exe(?:\.blockmap)?)$/.test(name)) {
      res.writeHead(404).end(); return;
    }
    const file = path.join(directory, name);
    let stat; try { stat = fs.statSync(file); } catch { res.writeHead(404).end(); return; }
    const type = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (range) {
      const suffix = range[1] === '' && range[2] !== '';
      start = suffix ? Math.max(0, stat.size - Number(range[2])) : (range[1] ? Number(range[1]) : 0);
      end = !suffix && range[2] ? Number(range[2]) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      status = 206;
    }
    const headers = {
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': type,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
module.exports = { startLocalUpdates };
