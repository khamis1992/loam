import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { OllamaClient } from '../ollama.js';
import { auditAcceptanceContract } from '../agent/acceptanceAudit.js';

// Independent diagnostic on preserved evidence, never edits the live task.
const snapshot = path.resolve('output/verification/bot-updated-quote-contract-observation/app-verification.json');
const trial = JSON.parse(fs.readFileSync('docs/evidence/bot-updated-quote-20261019-1731.json', 'utf8'));
assert.equal(typeof trial.request, 'string');
const original = fs.readFileSync(snapshot, 'utf8');
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
const sourceHash = digest(original);
const fixed = JSON.parse(original);
const boundary = fixed.scenarios[2];
const body = JSON.parse(boundary.apiChecks[0].requests[0].body);
assert.equal(body.items.length, 100);
assert.ok(body.items.every((i: any) => i.unitPriceCents === 10000000 && i.quantity === 100));
for (const item of body.items) item.quantity = 1;
assert.equal(body.items.reduce((sum: number, i: any) => sum + i.unitPriceCents * i.quantity, 0), 1000000000);
boundary.apiChecks[0].requests[0].body = JSON.stringify(body);
boundary.name = 'Valid subtotal cap: 100 items, 10000000 cents each, quantity 1 each';
const cases = [{ name: 'observed-wrong-expectation', contract: original, expected: 'revise' }, { name: 'corrected-control-copy', contract: JSON.stringify(fixed), expected: 'pass' }];
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ status: 'prepared; no model calls', sourceHash, cases: cases.map(c => ({ name: c.name, expected: c.expected })) }));
  process.exit(0);
}
const queue = await fetch('http://127.0.0.1:3939/api/queue', { signal: AbortSignal.timeout(15000) });
assert.ok(queue.ok);
const q = await queue.json() as any;
assert.equal(q.actives.length + q.queued.length, 0, 'Wait for current provider-heavy trial; never interrupt it');
const cfg = loadConfig(); cfg.model = 'glm-5.3-flash:cloud';
const client = new OllamaClient(cfg.ollamaUrl);
const output = `docs/evidence/bot-acceptance-audit-live-${Date.now()}.json`;
const evidence: Record<string, any> = { startedAt: new Date().toISOString(), sourceHash, model: cfg.model, pass: false, rows: [], caveat: 'Two diagnostic cases, not a reliability benchmark. Control is an in-memory copy; original task and frozen tests unchanged.' };
const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
save(); console.log(`Evidence: ${output}`);
try {
  for (const item of cases) {
    const start = Date.now();
    const result = await auditAcceptanceContract({ cfg, ollama: client, request: trial.request, contract: item.contract });
    evidence.rows.push({ name: item.name, expected: item.expected, elapsedMs: Date.now() - start, result }); save();
    console.log(JSON.stringify({ case: item.name, verdict: result.verdict, reason: result.reason }));
  }
  assert.equal(digest(fs.readFileSync(snapshot, 'utf8')), sourceHash);
  assert.equal(evidence.rows[0].result.verdict, 'revise');
  assert.ok(evidence.rows[0].result.scenarios.some((s: any) => s.index === 2 && s.verdict === 'revise'));
  assert.equal(evidence.rows[1].result.verdict, 'pass');
  evidence.pass = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally { evidence.finishedAt = new Date().toISOString(); save(); }
