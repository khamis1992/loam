'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 0;
fs.writeFileSync(path.join(process.cwd(), 'env-keys.txt'), Object.keys(process.env).sort().join('\n'));

const server = net.createServer();
server.on('error', (error) => {
  const code = error && error.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'FAIL';
  process.stdout.write(`${code}\n`);
  process.exit(code === 'EADDRINUSE' ? 98 : 1);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('READY\n');
  if (!args.includes('--exit-after-ready')) return;
  fs.appendFileSync(path.join(process.cwd(), 'crash-count.txt'), 'x');
  setTimeout(() => server.close(() => process.exit(1)), 150);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
