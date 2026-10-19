import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import type { ChatOptions, OllamaClient } from '../ollama.js';
import { auditAcceptanceContract } from '../agent/acceptanceAudit.js';
const cfg = loadConfig();
const request = 'Reject totals greater than 1000000000. Show the result in Arabic.';
const contract = JSON.stringify({ entry: 'index.html', scenarios: [{ name: 'boundary', steps: [{ action: 'visible', selector: 'h1' }] }] });
const row = { index: 0, verdict: 'pass', requestQuote: 'Show the result in Arabic.', reason: 'The display assertion has a basis in the request.' };
const valid = { verdict: 'pass', reason: 'supported', scenarios: [row] };
let calls = 0;
const client = (response: unknown) => ({ chat: async (o: ChatOptions) => {
  calls++;
  assert.equal(o.tools, undefined);
  assert.ok(o.signal);
  assert.ok(o.timeoutMs! <= 180000);
  assert.equal(o.messages.length, 2, 'implementation and planner history must not bias the review');
  assert.equal(JSON.parse(o.messages[1]!.content).originalRequest, request);
  return { content: JSON.stringify(response), model: 'audit-fixture', toolCalls: [], usage: { promptTokens: 10, completionTokens: 8, durationMs: 4 } };
} }) as unknown as OllamaClient;
const good = await auditAcceptanceContract({ cfg, request, contract, ollama: client(valid) });
assert.equal(good.verdict, 'pass'); assert.equal(good.contractSha256.length, 64);
const bad = await auditAcceptanceContract({ cfg, request, contract, ollama: client({ ...valid, verdict: 'revise', scenarios: [{ ...row, verdict: 'revise', requestQuote: 'Reject totals greater than 1000000000.', reason: 'The proposed success expectation exceeds the stated cap.' }] }) });
assert.equal(bad.verdict, 'revise');
for (const response of [null, [], {}, { ...valid, scenarios: [] }, { ...valid, scenarios: [row, row] }, { ...valid, scenarios: [{ ...row, index: 1 }] }, { ...valid, scenarios: [{ ...row, requestQuote: 'invented user requirement' }] }, { ...valid, scenarios: [{ ...row, verdict: 'revise' }] }]) {
  const before = calls;
  const result = await auditAcceptanceContract({ cfg, request, contract, ollama: client(response) });
  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.usage.completionTokens, 8, 'invalid responses retain known usage');
  assert.equal(calls, before + 1, 'malformed semantic responses must not be retried');
}
const before = calls;
const controller = new AbortController(); controller.abort();
await assert.rejects(auditAcceptanceContract({ cfg, request, contract, ollama: client(valid), signal: controller.signal }));
assert.equal(calls, before);
console.log('PASS complete grounded audit, contradiction/unavailability handling, no tools, bounded request and cancellation');
