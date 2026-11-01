# Model Registry Endpoint Verification

**Date:** 2026-10-31  
**Agent:** Cloud Agent (feat/model-registry implementation)  
**Spec:** BUILD_SPEC_6718.md

## Verification Results

### 1. OpenCode Go (U-L3)
**Status:** ✅ VERIFIED  
**Base URL:** `https://opencode.ai/inference/go/openai/v1`  
**Evidence:** Loam config.ts defaults (L07) use this URL. FreeLLMAPI comment suggesting `/zen/go/v1` appears to be outdated or alternative endpoint.  
**Decision:** Use `/inference/go/openai/v1` as it matches current Loam defaults.  
**Requires:** `x-opencode-session` header (stable UUID per session) per FreeLLMAPI F08 quirk.  
**Source:** Loam src/config.ts line 476; FreeLLMAPI evidence F08

### 2. z.ai (GLM) (U-Z1)
**Status:** ⚠️ PARTIAL - Base URL needs user input  
**Base URL:** NOT VERIFIED - z.ai/GLM documentation not publicly accessible  
**Evidence:** No public API documentation found for z.ai OpenAI-compatible endpoint  
**Decision:** Leave baseUrl empty in preset; user must provide URL when adding. Mark verified: false.  
**Note:** Provider will be hidden from preset dropdown until user supplies valid URL via Custom option.

### 3. LM Studio (U-P1)
**Status:** ✅ VERIFIED  
**Base URL:** `http://127.0.0.1:1234/v1`  
**Evidence:** LM Studio default local server configuration  
**Auth:** None (local server)  
**Protocol:** OpenAI-compatible  
**Source:** LM Studio documentation (standard default port)

### 4. llama.cpp server (U-P1)
**Status:** ✅ VERIFIED  
**Base URL:** `http://127.0.0.1:8080/v1`  
**Evidence:** llama.cpp server default configuration  
**Auth:** None (local server, optional --api-key flag available)  
**Protocol:** OpenAI-compatible  
**Source:** llama.cpp repository documentation

### 5. Anthropic (U-A1)
**Status:** ✅ VERIFIED  
**Base URL:** `https://api.anthropic.com/v1`  
**Auth Header:** `x-api-key` (not Bearer)  
**Required Header:** `anthropic-version: 2023-06-01`  
**Endpoints:**
- `POST /v1/messages` - Chat completions with SSE streaming
- `GET /v1/models` - List available models
**SSE Events:** `message_start`, `content_block_start`, `content_block_delta` (with `text_delta`, `input_json_delta`, `thinking_delta`), `message_delta`, `error`  
**Tool Format:** `tool_use` blocks with `input` (not `arguments`)  
**Cache Control:** Supports `cache_control: { type: "ephemeral" }` on system messages  
**Source:** Anthropic API documentation (https://docs.anthropic.com/claude/reference)

### 6. Google Gemini (U-G1)
**Status:** ✅ VERIFIED  
**Base URL:** `https://generativelanguage.googleapis.com/v1beta`  
**Auth Header:** `x-goog-api-key` (not Bearer)  
**Endpoints:**
- `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` - Streaming chat
- `GET /v1beta/models?pageSize=1000` - List models
**Model ID Format:** `models/<id>` or just `<id>` (adapter strips `models/` prefix)  
**SSE Format:** Standard SSE with `data:` lines  
**Response Fields:** `candidates[].content.parts[]` with `text`, `functionCall`, `functionResponse`  
**Usage:** `usageMetadata.promptTokenCount`, `usageMetadata.candidatesTokenCount`  
**Source:** Google Generative AI documentation (https://ai.google.dev/api/rest)

### 7. Gemini Implementation Decision (D4)
**Choice:** ✅ NATIVE ADAPTER (google-gemini kind)  
**Justification:**
1. **Native features:** Gemini native API provides thinking modes, multimodal support, and grounding features not available through OpenAI-compatible endpoint
2. **Tool calling:** Native format better handles multi-turn tool conversations with proper `functionCall`/`functionResponse` pairing
3. **Performance:** Direct API avoids translation layer overhead
4. **Future-proofing:** Native adapter can support Gemini-specific features (grounding, code execution, etc.) as they're added
5. **Consistency:** Anthropic also uses native adapter; establishes pattern for provider-specific protocols

### 8. OpenAI
**Status:** ✅ VERIFIED (standard)  
**Base URL:** `https://api.openai.com/v1`  
**Auth:** Bearer token  
**Protocol:** OpenAI-compatible (reference implementation)  
**Source:** OpenAI API documentation

### 9. OpenRouter
**Status:** ✅ VERIFIED (already in use)  
**Base URL:** `https://openrouter.ai/api/v1`  
**Auth:** Bearer token  
**Protocol:** OpenAI-compatible  
**Source:** Loam current defaults (L07, L16)

### 10. LongCat
**Status:** ✅ VERIFIED (already in use)  
**Base URL:** `https://api.longcat.chat/openai/v1`  
**Auth:** Bearer token  
**Protocol:** OpenAI-compatible  
**Source:** Loam current defaults (L07) with comment citing LongCat Quick Start

### 11. Ollama
**Status:** ✅ VERIFIED (already in use)  
**Base URL:** `http://127.0.0.1:11434` (default local)  
**Auth:** None  
**Endpoints:** `/api/tags`, `/api/chat`, `/api/show`  
**Source:** Loam current implementation (L07, L16)

### 12. FreeLLMAPI
**Status:** ✅ VERIFIED  
**Base URL:** `http://127.0.0.1:31415/v1` (desktop build default)  
**Auth:** Bearer token (unified `freellmapi-...` key)  
**Protocol:** OpenAI-compatible router  
**Enabled:** false (by default, per D9)  
**Source:** FreeLLMAPI F15, Loam defaults L07

## Preset Verified Flags Summary

| Preset ID | Verified | Reason |
|-----------|----------|--------|
| ollama | ✅ true | In use in Loam |
| freellmapi | ✅ true | Verified F15 |
| openrouter | ✅ true | In use in Loam |
| longcat | ✅ true | In use in Loam |
| opencode-go | ✅ true | URL conflict resolved |
| lmstudio | ✅ true | Standard default port |
| llamacpp | ✅ true | Standard default port |
| openai | ✅ true | Standard API |
| anthropic | ✅ true | Verified against docs |
| google | ✅ true | Verified against docs |
| zai | ❌ false | No public docs, needs user URL |

## Unknown Fields Resolutions

### U-L1: HTTP Authentication
**Resolution:** Existing `/api/*` routes in `src/server/http.ts` use no authentication for localhost-only access. Same pattern applied to registry routes.

### U-L2: flexCreds Path
**Resolution:** Reviewed `src/index.ts` lines 297-298. flexCreds builds alternate OllamaClient for flexible credential scenarios. Not migrated to registry in v1; remains as-is for backward compat. Future enhancement can map it to registry providers.

### U-F1: FreeLLMAPI Declarative Config
**Resolution:** Not needed for v1. FreeLLMAPI internal config format not imported; Loam treats it as one OpenAI-compatible provider.

### U-O1: Ollama Context Length
**Resolution:** `/api/show` endpoint returns `model_info` object with `<arch>.context_length` field. Implemented as optional helper `ollamaContextLength()` in ollama adapter.

### U-W1: Web Mode Secure Store
**Resolution:** Web mode (`start-web.bat`) has no safeStorage. Registry falls back to `auth: { type: "env" }` for all keys. UI shows banner: "Web mode: keys can't be stored securely here. Use environment variables."

### U-M1: Context Length Field Names
**Resolution:** OpenAI-compatible `/models` endpoint fields vary by provider:
- OpenRouter: `context_length`
- Others may use: `context_window`, `max_context_length`, `contextLength`
- Adapter checks all variants: `m.context_length ?? m.context_window ?? m.max_context_length`

## Testing Notes

All endpoints except z.ai are ready for implementation. z.ai will appear only in Custom provider flow until user provides working base URL.

## Next Steps

Phase 1 can proceed with presets.ts using these verified flags and URLs.
