import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { runWordRenderProcess } from '../studio/word-render-process.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'word-render-lifecycle-'));
const output = path.join(dir, 'preview.pdf');
const run = (code: string, timeout = 4000) => runWordRenderProcess(process.execPath,
  ['--input-type=module', '-e', code, output], output, { timeout, cleanupGrace: 150, pollInterval: 25 });
const write = `import fs from 'node:fs'; const out=process.argv[1]; fs.writeFileSync(out,'%PDF-complete');`;
try {
  // Completed export, followed by an indefinitely stuck COM shutdown equivalent.
  let started = Date.now();
  await run(write + `fs.writeFileSync(out+'.ready','exported'); setInterval(()=>{},1000);`);
  assert.ok(Date.now() - started < 3500, 'completed PDF must not wait for the rendering timeout');
  assert.equal(await fs.readFile(output, 'utf8'), '%PDF-complete');
  await fs.rm(output + '.ready');
  // A partial output without the completion protocol must not be recovered.
  await assert.rejects(run(write + 'process.exit(2);'));
  await assert.rejects(run(write + 'setInterval(()=>{},1000);', 500));
  // Failure during shutdown is recoverable only after completed export.
  await run(write + `fs.writeFileSync(out+'.ready','exported'); process.exit(2);`);
  await fs.rm(output + '.ready');
  await run(write);
  console.log('PASS completed export with stalled/failed teardown, partial-output rejection, timeout and normal exit');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
