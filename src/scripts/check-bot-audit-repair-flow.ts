import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { runAgent } from '../agent/loop.js';
import { runOrchestratedAgent } from '../agent/orchestrator.js';
import type { AgentEvent } from '../agent/events.js';
import type { ChatOptions, OllamaClient } from '../ollama.js';
import { ToolRegistry } from '../tools/registry.js';

for (const planned of [false, true]) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-audit-repair-'));
  cfg.fallbackModel = cfg.model;
  const request = 'Display the exact heading Ready.';
  const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="title">Ready</h1>';
  const correct = { entry: 'index.html', scenarios: [{ name: 'heading', steps: [{ action: 'textExact', selector: '#title', value: 'Ready' }] }] };
  const wrong = structuredClone(correct); wrong.scenarios[0]!.steps[0]!.value = 'Wrong';
  const contractFile = path.join(cfg.workspace, 'app-verification.json');
  fs.writeFileSync(path.join(cfg.workspace, 'index.html'), html);
  fs.writeFileSync(contractFile, JSON.stringify(wrong));
  let workers = 0, audits = 0, calls = 0;
  const events: AgentEvent[] = [];
  const client = { chat: async (o: ChatOptions) => {
    calls++;
    const system = o.messages[0]!.content;
    let response: unknown;
    if (system.startsWith('You independently audit')) {
      audits++;
      const proposal = JSON.parse(o.messages[1]!.content).proposedContract;
      const verdict = proposal.scenarios[0].steps[0].value === 'Ready' ? 'pass' : 'revise';
      assert.equal(fs.readFileSync(path.join(cfg.workspace, 'index.html'), 'utf8'), html);
      response = { verdict, reason: 'Compare literal heading with original request', scenarios: [{ index: 0, verdict, requestQuote: request, reason: 'The requested heading is Ready, never Wrong.' }] };
    } else if (system.startsWith('You are an independent acceptance-test author')) {
      response = { contract: correct, basis: [request] };
    } else if (system.includes('planner role')) {
      response = { goal: request, trivial: false, steps: [{ id: 's1', title: 'heading', instruction: request, successCriteria: 'Ready heading exists' }] };
    } else if (system.startsWith('You judge ') || o.messages.some(m => m.images?.length)) {
      response = { verdict: 'pass', reason: 'fixture review', fixes: [], issues: [], finalAnswer: 'The Ready heading passed runtime and visual checks.' };
    } else {
      workers++;
      if (workers === 2) {
        assert.ok(events.some(e => e.type === 'tool_result' && e.name === 'acceptance_contract_audit' && !e.ok));
        assert.ok(!events.some(e => e.type === 'done' || e.type === 'assistant_message'));
        fs.writeFileSync(contractFile, JSON.stringify(correct));
      }
      return { model: 'fixture', content: 'Heading created', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    }
    return { model: 'fixture', content: JSON.stringify(response), toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  } } as unknown as OllamaClient;
  const result = await (planned ? runOrchestratedAgent : runAgent)({ cfg, ollama: client, prompt: request, tools: new ToolRegistry(), emit: e => events.push(e) });
  assert.equal(workers, 2); assert.equal(audits, 2);
  assert.equal(result.verified, true);
  assert.equal(result.usage.promptTokens, calls);
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'index.html'), 'utf8'), html, 'test repair must not corrupt correct application');
  assert.deepEqual(JSON.parse(fs.readFileSync(contractFile, 'utf8')), correct);
  const passIndex = events.findIndex(e => e.type === 'verify' && e.verdict === 'pass');
  assert.ok(passIndex >= 0 && events.findIndex(e => e.type === 'done') > passIndex);
  console.log(`PASS ${planned ? 'planned' : 'direct'}: wrong expectation repaired before freeze; unchanged correct app passes real browser gates`);
}
