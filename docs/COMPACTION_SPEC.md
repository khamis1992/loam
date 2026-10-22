# Compaction spec note (J11)

This note compares Loam's context compaction with jcode's compaction core
(`ref/compaction-core.rs`) and records the reasoning for each value.

Loam's compaction lives in a single module, `src/agent/contextCompressor.ts`
(`compressContext`), wired into the agent loop at `src/agent/loop.ts` and
configured by `Config.compression` in `src/config.ts`. There is no second
compressor; the agentport `ap-compress` workstream (merged as `e0b18b5`) is the
origin of this module.

## Value comparison

| Constant | jcode | Loam | Match | Where |
|---|---|---|---|---|
| Token budget (default window) | `DEFAULT_TOKEN_BUDGET` = 200,000 | no fixed budget; per-model `contextWindow` (default 32,768) | intentional difference | `src/config.ts` `compression.contextWindow` |
| Trigger threshold | `COMPACTION_THRESHOLD` = 0.80 | `thresholdPercent` = 0.50 | intentional difference | `compression.thresholdPercent` |
| Critical threshold | `CRITICAL_THRESHOLD` = 0.95 | `criticalThresholdPercent` = 0.95 | **parity (added)** | `compression.criticalThresholdPercent` |
| Recent turns kept verbatim | `RECENT_TURNS_TO_KEEP` = 10 | `recentTurnsToKeep` = 10 | **parity (added)** | `compression.recentTurnsToKeep` |
| Minimum turns kept | `MIN_TURNS_TO_KEEP` = 2 | `minTurnsToKeep` = 2 | **parity (added)** | `compression.minTurnsToKeep` |
| Emergency tool-result cap | `EMERGENCY_TOOL_RESULT_MAX_CHARS` = 4000 | `emergencyToolResultMaxChars` = 4000 | **parity (added)** | `compression.emergencyToolResultMaxChars` |
| Manual compaction minimum | `MANUAL_COMPACT_MIN_THRESHOLD` = 0.10 | n/a | not applicable | Loam has no user-invoked compaction command |
| Emergency image cap | `EMERGENCY_IMAGE_MAX_CHARS` = 1024 | n/a | not applicable | Loam has no inline-image transcript blocks |
| Payload image budget | `PAYLOAD_IMAGE_CHAR_BUDGET` = 12 MiB | n/a | not applicable | no inline images |
| Image token cost | `IMAGE_TOKEN_COST` = 1,600 | n/a | not applicable | no inline images |
| System overhead tokens | `SYSTEM_OVERHEAD_TOKENS` = 18,000 | n/a | intentional difference | see below |
| Chars per token | `CHARS_PER_TOKEN` = 4 | 4 (`estimateTokens`) | parity | `estimateTokens` |
| Tool-image decay thresholds | 12 images / 48 MiB / keep 6 | n/a | not applicable | no inline images |
| Compaction summary prompt | `SUMMARY_PROMPT` (4 sections) | `buildSummaryPrompt` | equivalent, locally tuned | `buildSummaryPrompt` |

## Justification for each value

### Token budget

jcode fixes a single 200k budget that matches the largest Claude window and
scales its overhead term by budget size. Loam is a multi-provider client
(`ollama` plus OpenAI-compatible failover providers, `src/config.ts` `failover`),
so the window is per-model and resolved by longest-prefix match in
`getContextWindow`. A fixed 200k budget would be wrong for a 32k local model and
for a 1M-token Gemini window alike. The per-model table is therefore kept, and
the *fractions* of the window are what are ported from jcode.

### Trigger threshold (0.50 vs 0.80)

Loam triggers at 50% of the window, earlier than jcode's 80%. This is deliberate:
Loam's summarizer is an auxiliary model call whose own prompt is built from the
middle of the transcript, so compressing early keeps that auxiliary prompt small
and bounds the worst-case latency added before the next real request. jcode's
compaction manager can run summarization in the background, which changes the
trade-off. Changing this value is out of scope for J11; it is recorded here so
the divergence is explicit rather than accidental.

### Critical threshold (0.95) and the emergency path

jcode's `CRITICAL_THRESHOLD` marks the point where a *synchronous* hard compact
must happen, because the next request would otherwise be rejected outright. Loam
had no such path: a transcript between 50% and 100% of the window went through
the summarizer, which costs a model round trip and can itself fail, at the worst
possible moment.

This is the main gap J11 closes. `compressContext` now computes

```
criticalRatio = max(thresholdPercent, criticalThresholdPercent)
critical       = floor(window * criticalRatio)
```

and when `originalTokens > critical` it takes the synchronous emergency path
(`emergencyCompact`) instead of calling the summarizer:

* keeps the system prompt (index 0) plus the newest `recentTurnsToKeep` messages;
* drops the middle and replaces it with a labelled compaction summary that
  states how many turns were dropped and at which percentage of the window the
  recovery happened;
* bounds every oversized `role: "tool"` result to `emergencyToolResultMaxChars`
  characters, keeping a head and a tail around a truncation marker;
* makes no auxiliary model call, so it cannot fail, hang, or add latency, and
  charges no tokens (`usage` is zeroed);
* emits `compaction` with `step: 3`, `emergency: true` and `droppedTurns`.

The emergency tail is nudged backwards over a run of `role: "tool"` messages so
a kept tool result is never separated from the `tool_call` that produced it, the
same invariant the normal path already enforces.

`criticalThresholdPercent` is clamped to `[0.05, 0.99]` and then raised to at
least `thresholdPercent` at the call site, so a misconfiguration can never make
the emergency path unreachable (a critical ratio at or below the trigger would be
dead code) nor push it past the window.

### Recent turns kept verbatim (10) and minimum turns kept (2)

These are ported verbatim. Ten turns of verbatim tail is enough to keep the
current task, the plan and the most recent file reads in context, while leaving
the summary to carry the earlier history. The minimum of two is the floor that
guarantees at least one exchange survives even in a very short transcript, so
the model always has a recent user turn to answer. Both are clamped to at least
one message, with the jcode defaults as fallback when the configured value is
not a finite number.

### Emergency tool-result cap (4000 chars)

Ported verbatim. A single tool output is the one thing that can blow past the
token estimate on its own: a large file read, a long shell output or a big JSON
payload. Bounding it to 4000 characters (roughly 1,000 tokens) keeps the
head and the tail, which is where the useful content of most outputs lives, and
drops the middle. The cap is applied only to `role: "tool"` messages, never to
user or assistant text, and only when the context is already past the critical
threshold.

### System overhead tokens

jcode adds a flat 18,000-token overhead for the system prompt and tool
definitions, because its token estimate counts message content only. Loam's
estimate is also content-only, so the same undercount exists, but Loam already
protects the system prompt and the newest message and triggers at 50%, which
absorbs the discrepancy for the models it ships. Adding an overhead term here
would change the trigger point for every existing configuration, so it is
recorded as a known difference rather than changed.

## What was added

* `Config.compression.criticalThresholdPercent`, `recentTurnsToKeep`,
  `minTurnsToKeep`, `emergencyToolResultMaxChars` with jcode defaults
  (0.95 / 10 / 2 / 4000) in `src/config.ts`.
* The synchronous emergency path in `src/agent/contextCompressor.ts`:
  `criticalThreshold`, `emergencyKeepTurns`, `emergencyMinTurns`,
  `emergencyToolResultMaxChars`, `emergencyTruncateToolResults`,
  `EMERGENCY_TRUNCATION_MARKER`, `emergencyCompact`, and `step: 3` on
  `CompressionResult`.
* `AgentEvent` `compaction` extended with `step: 3`, `emergency` and
  `droppedTurns` in `src/agent/events.ts`.
* Tests in `src/agent/__tests__/contextCompressor.test.ts` covering the default
  values, malformed-value clamping, the critical-ratio clamp, tool-result
  truncation, the emergency path itself, and the tool-pair invariant under
  emergency compaction.

No second compressor was introduced and no existing behaviour was weakened: the
normal step 1 (prune) and step 2 (prune + summarize) paths are unchanged, and the
summarizer failure fallbacks still return the pruned transcript.

## Ported-code notice

The emergency constants, the truncation marker text and the head/tail truncation
shape are adapted from jcode (MIT), `src/compaction/compaction-core.rs`.
See `THIRD_PARTY_NOTICES` at the repository root.
