import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { chatWithFallback } from '../agent/model.js';
import type { OllamaClient } from '../ollama.js';
import { log } from '../log.js';

const cfg = loadConfig(); cfg.model = 'primary'; cfg.fallbackModel = 'fallback';
const rows: Array<Record<string, any>> = [];
const savedInfo = log.info, savedWarn = log.warn;
log.info = (label, row) => { if (label === 'model_request') rows.push(row as Record<string, any>); };
log.warn = () => {};
try {
  let calls = 0;
  const result = await chatWithFallback({ cfg, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], ollama: {
    chat: async () => {
      calls++;
      if (calls === 1) throw new Error('provider unavailable');
      return { content: 'PRIVATE_RESPONSE', model: 'fallback', toolCalls: [], usage: { promptTokens: 12, completionTokens: 4, durationMs: 3 } };
    },
  } as unknown as OllamaClient });
  assert.equal(result.content, 'PRIVATE_RESPONSE');
  assert.equal(calls, 2);
  assert.deepEqual(rows.map(r => [r.attempt, r.phase]), [[1, 'start'], [1, 'failed'], [2, 'start'], [2, 'complete']]);
  assert.equal(new Set(rows.map(r => r.requestId)).size, 1);
  assert.ok(rows.every(r => typeof r.requestId === 'string' && r.requestId.length > 0));
  assert.equal(rows[3]!.providerDurationMs, 3);
  assert.ok(rows.filter(r => r.phase !== 'start').every(r => Number.isInteger(r.elapsedMs) && r.elapsedMs >= 0));
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_'), 'timings must not record conversation content');
  const firstId = rows[0]!.requestId;
  rows.length = 0;
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(chatWithFallback({ cfg, messages: [], signal: controller.signal, ollama: {
    chat: async () => { calls++; controller.abort(); throw new Error('cancel'); },
  } as unknown as OllamaClient }));
  assert.equal(calls, 1, 'cancellation must not invoke fallback');
  assert.deepEqual(rows.map(r => r.phase), ['start', 'cancelled']);
  assert.notEqual(rows[0]!.requestId, firstId);
} finally { log.info = savedInfo; log.warn = savedWarn; }
console.log('PASS model timing correlation, metadata privacy, fallback and cancellation');
