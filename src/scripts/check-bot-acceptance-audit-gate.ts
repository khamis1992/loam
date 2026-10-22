import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import type { ChatOptions, OllamaClient } from '../ollama.js';
import { AcceptanceGuard } from '../agent/acceptanceGuard.js';
import { verifyFinal } from '../agent/verifier.js';
const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-audit-gate-'));
const request = 'Show the result in Arabic.';
const contract = JSON.stringify({ entry: 'missing.html', scenarios: [{ name: 'result', steps: [{ action: 'visible', selector: 'h1' }] }] });
const file = path.join(cfg.workspace, 'app-verification.json');
const options = { cfg, request, goal: request, finalText: 'ready', completedSteps: [], trace: [] };
let calls = 0;
function client(verdict: 'pass' | 'revise', mutate = false): OllamaClient {
  return { chat: async (o: ChatOptions) => {
    calls++;
    assert.match(o.messages[0]!.content, /independently audit/);
    if (mutate) fs.writeFileSync(file, contract.replace('missing.html', 'changed.html'));
    return { content: JSON.stringify({ verdict, reason: 'reviewed', scenarios: [{ index: 0, verdict, requestQuote: request, reason: 'The expectation was reviewed against the requested result.' }] }), model: 'fixture', toolCalls: [], usage: { promptTokens: 7, completionTokens: 3, durationMs: 2 } };
  } } as unknown as OllamaClient;
}
fs.writeFileSync(file, '{invalid');
const malformedGuard = new AcceptanceGuard();
const malformed = await verifyFinal({ ...options, acceptanceGuard: malformedGuard, ollama: client('pass') });
assert.equal(malformed.verdict, 'revise');
assert.notEqual(malformed.unavailable, true, 'schema errors are repairable, not reviewer outages');
assert.equal(calls, 0); assert.equal(malformedGuard.snapshot(), undefined);
fs.writeFileSync(file, contract);
const rejectedGuard = new AcceptanceGuard();
const rejected = await verifyFinal({ ...options, acceptanceGuard: rejectedGuard, ollama: client('revise') });
assert.equal(rejected.verdict, 'revise'); assert.equal(rejected.unavailable, false);
assert.equal(rejectedGuard.snapshot(), undefined, 'rejected expectations must not freeze');
assert.equal(fs.readFileSync(file, 'utf8'), contract, 'auditor must never modify contract');
assert.equal(rejected.usage.promptTokens, 7);

const staleGuard = new AcceptanceGuard();
const stale = await verifyFinal({ ...options, acceptanceGuard: staleGuard, ollama: client('pass', true) });
assert.equal(stale.unavailable, true); assert.equal(staleGuard.snapshot(), undefined);
assert.match(stale.reason, /changed during independent review/);

fs.writeFileSync(file, contract);
const approvedGuard = new AcceptanceGuard();
const approved = await verifyFinal({ ...options, acceptanceGuard: approvedGuard, ollama: client('pass') });
assert.equal(approvedGuard.snapshot(), contract, 'freeze exact reviewed bytes');
assert.equal(approved.verdict, 'revise', 'audit PASS cannot bypass missing application/runtime proof');
assert.equal(approved.usage.promptTokens, 7, 'audit usage counted once');
assert.throws(() => approvedGuard.freezeReviewedContract(contract), /Cannot replace/);

const explicit = new AcceptanceGuard(undefined, `Save app-verification.json with exactly this contract: ${contract}`);
fs.writeFileSync(file, contract.replace('h1', 'h2'));
const before = calls;
const frozen = await verifyFinal({ ...options, acceptanceGuard: explicit, ollama: client('pass') });
assert.equal(calls, before, 'explicit/frozen contract must not be reauthorized by an audit');
assert.equal(frozen.verdict, 'revise');
assert.match(frozen.reason, /Frozen acceptance scenario/);
assert.equal(explicit.snapshot(), contract);

// New checks appended during repair must not bypass semantic review or freeze on rejection.
const extended = JSON.parse(contract);
extended.scenarios.push({ name: 'added result', steps: [{ action: 'visible', selector: 'h2' }] });
const extendedRaw = JSON.stringify(extended);
const additionsGuard = new AcceptanceGuard(contract);
const reviewSubset = JSON.parse(additionsGuard.contractForReview(extendedRaw)!);
assert.equal(reviewSubset.scenarios.length, 1);
assert.equal(reviewSubset.scenarios[0].steps[0].selector, 'h2');
assert.equal(additionsGuard.snapshot(), contract, 'preview cannot freeze added checks');
fs.writeFileSync(file, extendedRaw);
const additionRejected = await verifyFinal({ ...options, acceptanceGuard: additionsGuard, ollama: client('revise') });
assert.equal(additionRejected.verdict, 'revise');
assert.equal(additionRejected.unavailable, false);
assert.equal(additionsGuard.snapshot(), contract, 'bad addition remains correctable');
assert.equal(fs.readFileSync(file, 'utf8'), extendedRaw, 'review cannot edit worker files');
const additionApproved = await verifyFinal({ ...options, acceptanceGuard: additionsGuard, ollama: client('pass') });
assert.equal(additionApproved.verdict, 'revise', 'approved addition cannot bypass missing application');
assert.equal(additionsGuard.snapshot(), extendedRaw);
assert.equal(additionApproved.usage.promptTokens, 7);
const reordered = JSON.parse(extendedRaw);
reordered.scenarios.reverse(); reordered.scenarios[0].name = 'renamed';
assert.equal(additionsGuard.contractForReview(JSON.stringify(reordered)), undefined, 'reorder/rename does not need another model call');
fs.writeFileSync(file, JSON.stringify(reordered));
const beforeUnchanged = calls;
await verifyFinal({ ...options, acceptanceGuard: additionsGuard, ollama: client('pass') });
assert.equal(calls, beforeUnchanged);
assert.throws(() => additionsGuard.contractForReview(contract), /Frozen acceptance scenario/, 'approved additions cannot later be removed');

const staleAdditionGuard = new AcceptanceGuard(contract);
fs.writeFileSync(file, extendedRaw);
const staleAddition = await verifyFinal({ ...options, acceptanceGuard: staleAdditionGuard, ollama: client('pass', true) });
assert.equal(staleAddition.unavailable, true);
assert.equal(staleAdditionGuard.snapshot(), contract, 'stale additions never enter baseline');
console.log('PASS initial/additional review, rejection without freeze, stale-byte protection, explicit/frozen integrity, usage and mandatory runtime proof');
