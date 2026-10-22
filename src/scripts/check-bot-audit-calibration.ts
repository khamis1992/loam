import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { OllamaClient } from '../ollama.js';
import { parseAppContract } from '../agent/appVerification.js';
import { auditAcceptanceContract } from '../agent/acceptanceAudit.js';

// Diagnostic only: never creates tasks, changes generated files or replaces runtime gates.
const quoteRequest = 'Build a quote application. POST /api/quote takes items with integer unitPriceCents and quantity, integer discountPercent from 0 to 100, and integer shippingCents. subtotalCents is the sum of unitPriceCents times quantity and must be at most 1000000000; otherwise return HTTP 400 with {"error":"invalid"}. Round subtotalCents*discountPercent/100 to the nearest integer with halves rounded UP. Shipping is not discounted. Valid requests return HTTP 200 with exactly subtotalCents, discountCents, shippingCents, totalCents; totalCents=subtotalCents-discountCents+shippingCents. Show the application heading.';
const bookingRequest = 'Build a booking application with a heading. POST /api/check receives existing and candidate intervals with integer start and end minutes, start strictly below end. Treat intervals as half-open [start,end): touching endpoints do not overlap. Return HTTP 200 with exactly {"conflict":true} when they overlap, otherwise {"conflict":false}.';
const contract = (route: string, body: unknown, status: number, expectedJson: unknown) => JSON.stringify({
  entry: 'index.html', runtime: { type: 'node', entry: 'server.mjs' }, scenarios: [{
    name: 'Check required response', steps: [{ action: 'visible', selector: 'h1' }],
    apiChecks: [{ requests: [{ method: 'POST', path: route, body: JSON.stringify(body), expectedJson }], statuses: [status] }],
  }],
});
const halfBody = { items: [{ sku: 'A', unitPriceCents: 101, quantity: 1 }], discountPercent: 50, shippingCents: 19 };
const halfDiscount = Number((101n * 50n + 50n) / 100n);
assert.equal(halfDiscount, 51);
const halfCorrect = { subtotalCents: 101, discountCents: halfDiscount, shippingCents: 19, totalCents: 69 };
const capBody = { items: [{ sku: 'B', unitPriceCents: 10000000, quantity: 101 }], discountPercent: 0, shippingCents: 0 };
assert.equal(BigInt(capBody.items[0]!.unitPriceCents) * BigInt(capBody.items[0]!.quantity), 1010000000n);
const adjacent = { existing: { start: 60, end: 120 }, candidate: { start: 120, end: 180 } };
assert.equal(adjacent.existing.start < adjacent.candidate.end && adjacent.candidate.start < adjacent.existing.end, false);
const cases = [
  { id: 'rounding-valid', request: quoteRequest, contract: contract('/api/quote', halfBody, 200, halfCorrect), expected: 'pass' },
  { id: 'rounding-invalid', request: quoteRequest, contract: contract('/api/quote', halfBody, 200, { ...halfCorrect, discountCents: 50, totalCents: 70 }), expected: 'revise' },
  { id: 'cap-valid', request: quoteRequest, contract: contract('/api/quote', capBody, 400, { error: 'invalid' }), expected: 'pass' },
  { id: 'cap-invalid', request: quoteRequest, contract: contract('/api/quote', capBody, 200, { subtotalCents: 1010000000, discountCents: 0, shippingCents: 0, totalCents: 1010000000 }), expected: 'revise' },
  { id: 'adjacent-valid', request: bookingRequest, contract: contract('/api/check', adjacent, 200, { conflict: false }), expected: 'pass' },
  { id: 'adjacent-invalid', request: bookingRequest, contract: contract('/api/check', adjacent, 200, { conflict: true }), expected: 'revise' },
] as const;
for (const item of cases) parseAppContract(item.contract);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ status: 'prepared; schema and deterministic oracle checks passed; no model calls', cases: cases.length, repetitions: 3, suiteSha256: hash(JSON.stringify(cases)) }));
} else {
  const cfg = loadConfig(); cfg.model = 'glm-5.3-flash:cloud';
  const client = new OllamaClient(cfg.ollamaUrl);
  const output = `docs/evidence/bot-audit-calibration-${Date.now()}.json`;
  const evidence: Record<string, any> = { startedAt: new Date().toISOString(), pass: false, model: cfg.model, suiteSha256: hash(JSON.stringify(cases)), observerSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')), cases, rows: [], caveat: 'Six paired semantic diagnostics repeated three times, not end-to-end reliability or competitive parity. Unavailable and incorrect verdicts count as not passed. No semantic retries or task edits.' };
  const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  save(); console.log(`Evidence: ${output}`);
  try {
    for (let round = 0; round < 3; round++) {
      // Rotate the order; expected labels and case IDs are never sent to the reviewer.
      for (let offset = 0; offset < cases.length; offset++) {
        const queueResponse = await fetch('http://127.0.0.1:3939/api/queue', { signal: AbortSignal.timeout(15000) });
        assert.ok(queueResponse.ok);
        const queue = await queueResponse.json() as any;
        assert.equal(queue.actives.length + queue.queued.length, 0, 'Do not contend with a live task; preserve partial diagnostic evidence');
        const item = cases[(offset + round) % cases.length]!;
        const started = Date.now();
        const result = await auditAcceptanceContract({ cfg, ollama: client, request: item.request, contract: item.contract });
        const row = { round: round + 1, id: item.id, expected: item.expected, pass: result.verdict === item.expected, elapsedMs: Date.now() - started, result };
        evidence.rows.push(row); save();
        console.log(JSON.stringify({ round: row.round, id: row.id, pass: row.pass, verdict: result.verdict }));
      }
    }
    evidence.pass = evidence.rows.length === 18 && evidence.rows.every((r: any) => r.pass);
    if (!evidence.pass) process.exitCode = 1;
  } catch (error) { evidence.error = String(error); process.exitCode = 1; }
  finally {
    evidence.summary = { attempted: evidence.rows.length, planned: 18, correct: evidence.rows.filter((r: any) => r.pass).length, falsePasses: evidence.rows.filter((r: any) => r.expected === 'revise' && r.result.verdict === 'pass').length, falseRejections: evidence.rows.filter((r: any) => r.expected === 'pass' && r.result.verdict === 'revise').length, unavailable: evidence.rows.filter((r: any) => r.result.verdict === 'unavailable').length };
    evidence.finishedAt = new Date().toISOString(); save();
  }
}
