import assert from "node:assert/strict";
import { visualReview, VisualReviewUnavailable } from "../agent/visualReview.js";
import type { OllamaClient, ChatOptions } from "../ollama.js";
import { IncompleteModelStream } from "../ollama.js";
const options: ChatOptions = { model: "same-vision-model", messages: [{ role: "user", content: "inspect actual image", images: ["unchanged-image-bytes"] }] };
const response = { content: '{"verdict":"pass","issues":[]}', model: options.model, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
let calls = 0;
const flaky = { chat: async (o: ChatOptions) => { calls++; assert.deepEqual(o, options); if (calls === 1) throw new DOMException("timed out", "TimeoutError"); return response; } } as unknown as OllamaClient;
const recovered = await visualReview(flaky, options);
assert.equal(recovered.attempts, 2); assert.equal(calls, 2);
for (const provider of ['cloud','ollama'] as const) {
 calls=0;
 const truncated={chat:async(o:ChatOptions)=>{calls++;assert.deepEqual(o,options);if(calls===1)throw new IncompleteModelStream(provider);return response;}} as unknown as OllamaClient;
 assert.equal((await visualReview(truncated,options)).attempts,2);assert.equal(calls,2);
 calls=0;
 await assert.rejects(visualReview({chat:async()=>{calls++;throw new IncompleteModelStream(provider);}} as unknown as OllamaClient,options),e=>e instanceof VisualReviewUnavailable&&e.attempts===2);
 assert.equal(calls,2);
}
for (const content of ['{broken','{"verdict":"revise","reason":"IncompleteModelStream"}']) {
 calls=0;
 const invalid={chat:async()=>{calls++;return {...response,content};}} as unknown as OllamaClient;
 assert.equal((await visualReview(invalid,options)).result.content,content);assert.equal(calls,1);
}
calls = 0;
const offline = { chat: async () => { calls++; throw new Error("ollama /api/chat HTTP 503"); } } as unknown as OllamaClient;
await assert.rejects(visualReview(offline, options), e => e instanceof VisualReviewUnavailable && e.attempts === 2);
assert.equal(calls, 2);
calls = 0;
const rejection = { chat: async () => { calls++; return { ...response, content: '{"verdict":"revise","issues":["wrong shape"]}' }; } } as unknown as OllamaClient;
assert.equal((await visualReview(rejection, options)).attempts, 1); assert.equal(calls, 1);
calls = 0;
const unauthorized = { chat: async () => { calls++; throw new Error("ollama /api/chat HTTP 401"); } } as unknown as OllamaClient;
await assert.rejects(visualReview(unauthorized, options), e => e instanceof VisualReviewUnavailable && e.attempts === 1);
assert.equal(calls, 1);
const cancelled = new AbortController(); cancelled.abort(); calls = 0;
await assert.rejects(visualReview(flaky, { ...options, signal: cancelled.signal })); assert.equal(calls, 0);
console.log("PASS visual retry keeps model/images, retries transient failure only twice, preserves semantic rejection and honors cancellation");
