# Ollama Think Mode Implementation - Task Plan

## Overview
Apply approved Loam change for local Ollama (qwen3.6) with explicit context/sampling/thinking control.

## Tasks

### 1. Core ollama.ts Changes
- [x] Add new fields to `ChatOptions` interface:
  - `think?: boolean` - enable/disable thinking mode
  - `numCtx?: number` - context window size
  - `numPredict?: number` - max prediction tokens
  - `topP?: number` - nucleus sampling
  - `topK?: number` - top-k sampling
  - `presencePenalty?: number` - presence penalty
  - `onThinking?: (text: string) => void` - thinking token callback
- [x] Add `thinking?: string` field to `ChatResult` interface
- [x] Create `localSamplingOptions()` helper function with Qwen-recommended defaults:
  - Thinking coding mode: temp 0.6, top_p 0.95, top_k 20
  - Non-thinking mode: temp 0.7, top_p 0.8, top_k 20, presence_penalty 1.5
  - Default num_ctx: 32768
- [x] Update `chatLocal()` to:
  - Accumulate `message.thinking` separately from `content` in stream processing
  - Send `think` parameter when set
  - Use `localSamplingOptions` instead of hardcoded temperature-only 0.2
  - Return `thinking` in ChatResult

### 2. Call-site Updates (think=false default)
- [x] Update `src/agent/loop.ts`:
  - Set `think: false` as runtime default for all ollama calls
  - Add escalation logic for hard tasks to use `think: true`:
    - Multi-file / architectural planning
    - Debugging after failed test
    - Math/algorithmic tasks
    - After think=false attempt fails validation
- [x] Update `src/agent/model.ts`:
  - Add `think` to ModelCallOptions
  - Pass through to ollama.chat with default false
- [x] Update `src/tools/routingModel.ts`:
  - Add `think` to RoutingCallOptions
  - Pass through to chatWithFallback and chatWithFailover
- [x] Verified `src/llm/codingRouter.ts`:
  - Uses ChatOptions which already includes think
  - No changes needed (flows through automatically)

### 3. Empty-Length Retry Logic
- [x] Add retry mechanism in `src/agent/model.ts`:
  - If think=true call returns empty content with `done_reason=length`
  - Retry once with `think=false`
  - Don't return empty answer

### 4. Verification
- [ ] Run TypeScript typecheck: `tsc --noEmit` or equivalent
- [ ] Run existing tests (identify test command from package.json)
- [ ] Add/extend unit test for:
  - Think + options are sent correctly
  - Thinking is kept separate from content
  - Empty-length retry path (if practical)

### 5. Git & PR
- [ ] Create feature branch from manus-parity: `cursor/ollama-think-mode-b542`
- [ ] Commit changes with descriptive message
- [ ] Push branch
- [ ] Create PR into manus-parity

## Constraints
- Touch only files needed for this behavior
- No unrelated refactors
- Do not address ollama/ollama#19191 (float coercion)
- Do not delete/replace models or change Ollama server config
- Keep thinking separate from content everywhere

## Success Criteria
- PR created into manus-parity
- All typecheck/tests pass (or pre-existing failures clearly reported)
- Commit hash documented
- Test results documented
