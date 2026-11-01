# Loam Unified Model Registry Implementation Plan

**Branch:** `feat/model-registry`  
**Target:** All phases 0-7, ONE pull request against main  
**Spec:** `/workspace/uploads/BUILD_SPEC_6718.md`

## Overview

Implement a unified model/provider registry that allows users to add ANY model:
- Ollama, local OpenAI-compatible (LM Studio, llama.cpp)
- Cloud providers (OpenAI, Anthropic, Gemini, OpenRouter, LongCat, OpenCode Go, z.ai, FreeLLMAPI, Custom)
- Secure key storage via Electron safeStorage (Windows DPAPI)
- Arabic + English UI
- Backward compatible with existing router/failover

## Approved Decisions
- ✅ Add `zod` dependency
- ✅ Migrate `cloudModel.apiKey` from config.json to safeStorage (with backup)
- ✅ Hide unverified presets (Custom always available)
- ✅ One key per provider in v1
- ✅ FreeLLMAPI provider off by default
- ✅ Gemini: choose native vs OpenAI-compatible endpoint (justify in PR)

## Phase 0: Verification & Dependencies
**Goal:** Resolve unknowns, add zod, verify endpoints, set preset flags

### Tasks
- [ ] 0.1: Read spec sections §7.8, §12.1, §12.2 thoroughly
- [ ] 0.2: Add `zod` to package.json dependencies (not devDependencies)
- [ ] 0.3: Run `npm install` to update package-lock.json
- [ ] 0.4: Verify OpenCode Go URL (spec conflict: `/inference/go/openai/v1` vs `/zen/go/v1`)
  - Check official OpenCode docs or make test call
  - Update preset URL in presets.ts
- [ ] 0.5: Verify z.ai base URL (marked UNKNOWN in spec)
  - Research z.ai/GLM API documentation
  - Update preset baseUrl in presets.ts
- [ ] 0.6: Verify LM Studio default port (spec says 1234)
  - Confirm from LM Studio docs
- [ ] 0.7: Verify llama.cpp server default port (spec says 8080)
  - Confirm from llama.cpp docs
- [ ] 0.8: Verify Anthropic API details (base URL, headers, endpoints)
  - Check Anthropic API docs for: base URL, `anthropic-version` header, `/models`, `/messages`
- [ ] 0.9: Verify Google Gemini API details (endpoints, auth header)
  - Check Google Generative AI docs for: base URL, `x-goog-api-key` header, endpoint formats
- [ ] 0.10: Decide Gemini implementation: native adapter vs Google's OpenAI-compatible endpoint
  - Document justification for PR body
- [ ] 0.11: Create `docs/model-registry/verification.md` with all verification results
  - Include URLs, dates, and findings for each endpoint
- [ ] 0.12: Update `src/models/registry/presets.ts` verified flags based on findings
- [ ] 0.13: Verify that existing `ollama.ts` functions can be reused (chatLocal for Ollama adapter)
- [ ] 0.14: Verify FreeLLMAPI on owner's machine (if available) - document if unavailable
- [ ] 0.15: Commit phase 0 changes

**Exit Criteria:** Every preset has evidence URL/date or stays `verified:false`; zod installed

---

## Phase 1: Types, Schema, Store, Redact
**Goal:** Core domain types, zod schemas, JSON persistence, secret redaction

### Tasks
- [ ] 1.1: Create `src/models/registry/types.ts` per spec §5.2
  - ProviderKind, ProviderLocation, AuthScheme, ProviderRecord, ModelCapabilities, ModelRecord, ModelChain, ModelRegistry
  - ProviderErrorCode, ConnectionTestResult, DiscoveredModel
- [ ] 1.2: Create `src/models/registry/schema.ts` per spec §5.3
  - Import zod
  - slug, httpUrl, HEADER_NAME, SECRET_HEADER patterns
  - AuthSchemeZ, ProviderZ, CapabilitiesZ, ModelZ, RegistryZ with superRefine validation
  - TestResultZ, DiscoveredModelZ schemas
- [ ] 1.3: Create `src/models/registry/store.ts` per spec §5.3 persistence
  - loadRegistry() from DATA_DIR/model-registry.json
  - saveRegistry() with atomic write (tmp + rename)
  - Keep .bak backup of previous version
  - Return parsed + validated registry
- [ ] 1.4: Create `src/models/registry/redact.ts` per spec §7.2
  - PATTERNS array (sk-, Bearer, x-api-key, AIza, freellmapi- patterns)
  - redactSecrets(text, known[]) function
  - Replace matches with "«redacted»"
- [ ] 1.5: Create `src/models/registry/schema.test.ts`
  - Valid registry passes
  - Rejects duplicate provider/model ids
  - Rejects model with unknown provider
  - Rejects chain/default referencing unknown model
  - Rejects Authorization/x-api-key in extraHeaders
  - Rejects ftp:// URLs
  - Rejects non-ASCII header values
  - Strips trailing slashes from URLs
- [ ] 1.6: Create `src/models/registry/redact.test.ts`
  - Each pattern is caught
  - Known secrets replaced
  - Short strings (<6 chars) not blanked
- [ ] 1.7: Run `npm run typecheck` - must pass
- [ ] 1.8: Run schema and redact tests - must pass
- [ ] 1.9: Commit phase 1 changes

**Exit Criteria:** schema/redact tests green, typecheck passes

---

## Phase 2: Migration, Compile, Resolve
**Goal:** Migrate legacy config, compile to failover format, resolve model refs

### Tasks
- [ ] 2.1: Create `src/models/registry/migrate.ts` per spec §5.7
  - migrateFromConfig(config, ollamaTagsFn, vaultPutFn) -> ModelRegistry
  - Deterministic, idempotent migration
  - Provider ollama-local from cfg.ollamaUrl
  - Provider cloud-legacy from cfg.cloudModel (if exists)
  - Migrate cfg.cloudModel.apiKey to vault (desktop mode only)
  - Process cfg.failover.providers
  - Create default/coding chains
  - Set defaultModelId/fallbackModelId
  - Apply compression.contextWindow as capabilities
  - Calculate sourceHash (SHA-256 of canonical JSON with apiKey replaced by "<set>" or "<empty>")
  - Never include actual key values in output
- [ ] 2.2: Create `src/models/registry/compile.ts` per spec §5.8
  - compileChain(registry, chainId?) -> CompiledProvider[]
  - CompiledProvider extends FailoverProvider with registryModelId, providerRef, modelRef
  - Return enabled models from specified chain (or default)
  - Map to FailoverProvider format (id, kind, baseUrl, model=remoteId, apiKeyEnv, enabled)
- [ ] 2.3: Create `src/models/registry/resolve.ts` per spec §5.6
  - resolveModelRef(ref, registry) -> ModelRecord | undefined
  - Rule 1: exact registry id (providerId/remoteId)
  - Rule 2: legacy name:cloud -> model on cloud-legacy provider, else Ollama model with full name:cloud
  - Rule 3: bare name -> first enabled model with remoteId === name (Ollama first)
  - Rule 4: undefined -> caller uses legacy path
- [ ] 2.4: Create `src/models/registry/migrate.test.ts`
  - Test (a): example config (spec L16) + defaults (spec L07) produces correct providers/models
    - ollama-local with qwen2.5:14b, ornith-1.5:9b, glm-5.3:cloud
    - cloud-legacy with glm-5.3-flash
    - opencode-go, freellmapi (disabled), longcat, openrouter providers
  - Test (b): glm-5.3:cloud stays on Ollama when tags list it
  - Test (c): idempotent - two runs produce identical JSON
  - Test (d): key value never in output or hash input
  - Test (e): web mode keeps env auth, doesn't modify config.json
  - Test (f): merge-mode re-import doesn't overwrite edited labels/capabilities
- [ ] 2.5: Create `src/models/registry/compile.test.ts`
  - Disabled model/provider skipped
  - Chain order preserved
  - apiKeyEnv only for env auth
  - providerKey() stable
- [ ] 2.6: Create `src/models/registry/resolve.test.ts`
  - Test all 4 resolution rules from §5.6
- [ ] 2.7: Run `npm run typecheck` - must pass
- [ ] 2.8: Run migrate/compile/resolve tests - must pass
- [ ] 2.9: Commit phase 2 changes

**Exit Criteria:** migrate/compile/resolve tests green

---

## Phase 3: Adapters (4 providers + helpers + dispatch)
**Goal:** Adapter interface, 4 protocol adapters, error handling, dispatch

### Tasks
- [ ] 3.1: Create `src/models/adapters/types.ts` per spec §7.1
  - AdapterContext (provider, secret, fetchImpl)
  - ProviderAdapter interface (chat, listModels, ping, probeTools)
  - ProviderError extends ProviderHttpError
  - PROBE_TOOL, genericProbeTools, genericPing helpers
- [ ] 3.2: Create `src/models/adapters/errors.ts` per spec §7.2
  - MAX_LIST_BYTES, MAX_MODELS, DAY constants
  - codeForStatus(status) -> ProviderErrorCode
  - readCapped(response, max) with streaming reader
  - retryAfterMs(response, body) - parse Retry-After header + body hints
  - httpError(response, what, secret) -> ProviderError
  - networkError(err, what) -> ProviderError
  - joinUrl, safeHeader, timeoutSignal helpers
  - sseJson(body) - async generator for SSE JSON lines
- [ ] 3.3: Create `src/models/adapters/openaiCompat.ts` per spec §7.3
  - isOpencode(baseUrl) helper
  - stableUuid(seed) for x-opencode-session header
  - oaHeaders(ctx) - build headers with Bearer/custom auth + OpenCode quirk
  - toOpenAIMessages(msgs) - convert Loam messages to OpenAI format with synthetic tool_call ids
  - openaiCompatAdapter: chat, listModels, ping, probeTools
  - SSE streaming with usage, tool calls, thinking (reasoning_content/reasoning)
- [ ] 3.4: Create `src/models/adapters/ollama.ts` per spec §7.4
  - Reuse existing OllamaClient.chatLocal
  - ollamaAdapter: chat, listModels, ping, probeTools
  - ollamaContextLength() optional helper for /api/show
- [ ] 3.5: Create `src/models/adapters/anthropic.ts` per spec §7.5
  - toAnthropicBody(opts) - convert to Anthropic messages format
  - Handle system instruction, tool_use, tool_result
  - anthropicAdapter: chat, listModels, ping, probeTools
  - SSE streaming with thinking_delta
  - Cache control when requested
- [ ] 3.6: Create `src/models/adapters/gemini.ts` per spec §7.6
  - Convert to Gemini messages format (role mapping, functionCall/functionResponse)
  - geminiAdapter: chat, listModels, ping, probeTools
  - Handle models/<id> prefix stripping
  - SSE streaming
- [ ] 3.7: Create `src/models/adapters/index.ts` per spec §7.7
  - adapterFor(kind) - dispatch to correct adapter
  - resolveSecret(provider, env) - get secret from env or vault
- [ ] 3.8: Create `src/models/adapters/openaiCompat.test.ts`
  - Mock fetch with SSE bodies
  - Test text deltas, reasoning_content, tool-call assembly
  - Test usage + cached tokens
  - Test [DONE] handling
  - Test mid-stream error
  - Test 401 -> auth, 429 + Retry-After, body retryDelay parsing
  - Test network error -> unreachable, timeout -> timeout
  - Test user abort rethrown
  - Test OpenCode host sends x-opencode-session
  - Test /models envelopes (data[], bare array, models[])
  - Test > 2MB -> bad_response, non-JSON -> bad_response
  - Test images become image_url parts
  - Test tool message id pairing
- [ ] 3.9: Create `src/models/adapters/anthropic.test.ts`
  - Test system extraction
  - Test cache_control only with cacheControl flag
  - Test tool_use/tool_result pairing
  - Test consecutive tool results merged into one user turn
  - Test images
  - Test stop_reason mapping
  - Test overloaded_error -> rate_limited
  - Test temperature omitted when thinking
- [ ] 3.10: Create `src/models/adapters/gemini.test.ts`
  - Test role mapping (user/model)
  - Test functionCall/functionResponse
  - Test models/ prefix strip
  - Test MAX_TOKENS -> length
  - Test list kind mapping
- [ ] 3.11: Create `src/models/adapters/ollama.test.ts`
  - Test /api/tags parse
  - Test unreachable handling
  - Test ollamaContextLength picks *.context_length
- [ ] 3.12: Create `src/models/adapters/errors.test.ts`
  - Test each redaction pattern
  - Test known secrets redacted
  - Test retryAfterMs parsing (header, body hints)
  - Test codeForStatus mappings
- [ ] 3.13: Run `npm run typecheck` - must pass
- [ ] 3.14: Run all adapter tests - must pass, NO network calls
- [ ] 3.15: Commit phase 3 changes

**Exit Criteria:** adapter tests green, no network calls

---

## Phase 4: Vault (Electron main + IPC + server client)
**Goal:** Secure key storage using safeStorage (DPAPI), IPC, server-side client

### Tasks
- [ ] 4.1: Create `electron/model-secrets.cjs` per spec §5.5 reference code
  - createVault(app, safeStorage) with available/put/replace/delete/list/get/hints methods
  - Storage: userData/model-secrets/<credentialId>.dpapi + index.json
  - Atomic writes (tmp + rename)
  - cleanValue() validates 1-4096 printable ASCII
  - hintOf() generates "...XXXX" hint
  - attachModelSecrets(child, app, safeStorage) - wire up IPC handlers
  - Listen for loam:model-secret-request, send loam:model-secret response
  - Send loam:model-secret-invalidate on replace/delete
  - Send loam:model-secret-hints at startup and after changes
- [ ] 4.2: Update `electron/ipc-constants.cjs`
  - Add "modelSecrets" to NAMESPACES array
- [ ] 4.3: Update `electron/main.cjs`
  - Import model-secrets.cjs
  - Call attachModelSecrets(serverChild, app, safeStorage) next to attachLegalKey
  - Register modelSecrets namespace handlers in IPC dispatcher
- [ ] 4.4: Update `electron/preload.cjs`
  - Expose modelSecrets methods: available, put, replace, delete, list
  - Follow existing pattern for other namespaces
- [ ] 4.5: Create `src/models/secrets/vault.ts` per spec §5.5 server-side client
  - SecretVault class with cache (10 min TTL)
  - Listen for loam:model-secret, loam:model-secret-invalidate, loam:model-secret-hints messages
  - get(credentialId) with async request pattern (5s timeout)
  - hints property (populated from main process)
  - Export singleton: vault = new SecretVault(process.parentPort ?? null)
- [ ] 4.6: Create `src/models/secrets/vault.test.ts`
  - Mock safeStorage (reversible XOR for testing)
  - Test put/get/replace/delete/list
  - Test index.json has no value
  - Test unavailable encryption throws secure_storage_unavailable
  - Test invalid UUID rejected
  - Test server SecretVault cache + invalidate
  - Test 5s request timeout
- [ ] 4.7: Run `npm run typecheck` - must pass
- [ ] 4.8: Run vault tests - must pass
- [ ] 4.9: Commit phase 4 changes

**Exit Criteria:** vault tests green

---

## Phase 5: Wire into Loam + HTTP routes
**Goal:** Integrate registry into config loading, failover, routing, HTTP API

### Tasks
- [ ] 5.1: Create `src/server/routes/modelRegistry.ts` per spec §5.4
  - GET /api/model-registry - return registry + secretsAvailable + mode + hints
  - GET /api/model-registry/presets?all=1 - return filtered presets
  - POST /api/model-registry/providers - create provider
  - PATCH /api/model-registry/providers/:id - update provider
  - DELETE /api/model-registry/providers/:id?cascade=true - delete provider
  - POST /api/model-registry/providers/:id/discover - list models from provider
  - POST /api/model-registry/providers/:id/test - test connection
  - POST /api/model-registry/test-draft - test draft provider
  - POST /api/model-registry/models - bulk create models
  - PATCH /api/model-registry/models/:id - update model
  - DELETE /api/model-registry/models/:id - delete model
  - PUT /api/model-registry/chains/:id - update chain
  - PUT /api/model-registry/defaults - set default/fallback models
  - POST /api/model-registry/reimport - merge from config.json
  - All routes use zod validation
  - All responses redact secrets
  - All error messages redacted
- [ ] 5.2: Update `src/config.ts`
  - Import registry store, migrate, compile
  - In loadConfig(): check if model-registry.json exists
  - If not exists: run migration, save registry
  - Load registry from file
  - Populate cfg.failover.providers from compileChain(registry)
  - Keep existing config.json structure for backward compat
  - Log one-time warning if plaintext cloudModel.apiKey remains
- [ ] 5.3: Update `src/llm/failover.ts` per spec §7.7, §8
  - Widen FailoverProvider.kind to include "anthropic" | "google-gemini"
  - Add CompiledProvider interface extending FailoverProvider
  - Update createProviderClient() to dispatch to adapters for registry providers
  - Keep legacy path unchanged (existing if p.kind === "ollama" etc.)
  - Update classifyFailure() with new rules:
    - local unreachable/timeout -> 5s cooldown (not 60s)
    - retryAfterMs present -> use it
    - code = auth -> also set provider.lastTest
    - code = billing -> 60 min
    - code = model_not_found -> skipSession: true
    - code = bad_request -> no cooldown, don't retry same entry
    - AbortError -> rethrown
  - Add capability gating before trying candidate:
    - tools required but capabilities.tools === false -> skip
    - images present but vision === false -> skip
    - estimated tokens * 1.25 > contextWindow -> skip
    - "unknown" never skips
    - If all gated, try unfiltered chain once
  - Update providerModel() to return remoteId for registry providers
  - Add hasUsableKey() check using vault.hints for bearer/header auth
  - Update isCloudProvider() to use providerRef.location when present
- [ ] 5.4: Update `src/llm/router.ts`
  - Routing map values may now be registry ids (providerId/remoteId format)
  - Update providersForModels() to match registry ids
  - Keep existing substring matching working
- [ ] 5.5: Update `src/llm/cloudModel.ts`
  - Update isCloudProvider() to check providerRef.location === "cloud"
  - Update pickCloudModel() to work with registry
- [ ] 5.6: Update `src/llm/codingRouter.ts`
  - Update to resolve chain from registry
  - Fall back to compiled chain when coding chain not found
- [ ] 5.7: Update `src/server/http.ts`
  - Mount /api/model-registry/* routes
  - Extend GET /api/models to include entries[] per spec §5.4
    - entries: { id, label, providerId, location, enabled, capabilities }[]
    - Keep existing models: string[] for backward compat
- [ ] 5.8: Create `src/llm/failover.registry.test.ts`
  - Test local unreachable -> 5s cooldown
  - Test retryAfterMs honored
  - Test model_not_found skips session
  - Test capability gating (tools, vision, contextWindow)
  - Test "unknown" never skips
  - Test all-gated -> unfiltered retry
  - Verify existing failover tests still pass
- [ ] 5.9: Run `npm run typecheck` - must pass
- [ ] 5.10: Run ALL existing `src/llm/*.test.ts` tests - must pass (same or better)
- [ ] 5.11: Run new failover.registry.test.ts - must pass
- [ ] 5.12: Commit phase 5 changes

**Exit Criteria:** All existing src/llm/*.test.ts + new tests green

---

## Phase 6: UI (Settings > Models screens S1-S9)
**Goal:** Complete UI for managing models - Arabic + English, no sparkle icons

### Tasks
- [ ] 6.1: Create `ui/models-settings.js` per spec §6
  - Import existing icons from ui/icons.js (plus, edit, trash, refresh, check, warning, drag-handle, eye/eye-off)
  - NO sparkle/star AI icons
  - S1: Models list screen
    - Default/fallback model selects
    - Provider list with status chips (Connected, Unreachable, Key rejected, etc.)
    - Model rows with capability badges (tools, vision, context window)
    - Enable/disable toggles
    - Test/Edit buttons
    - Chain editor with drag handles (≡) and Alt+Up/Down keyboard support
    - "Re-import from config.json" button
  - S2: Add model wizard - step 1/4 (source selection)
    - Radio buttons for: Ollama, Local OpenAI-compatible, FreeLLMAPI, Cloud (dropdown), Custom
    - Hide unverified presets
    - Next disabled until selection
  - S3: Step 2/4 (connection details)
    - Label, Protocol (locked for presets), Base URL
    - Auth: API key (password field + eye toggle), env var, or no key
    - Advanced: timeout, extra headers
    - Test connection button with results
    - Duplicate URL check
    - Cloud over http warning + checkbox
    - FreeLLMAPI unreachable message + "Save disabled" option
    - Key handling: call modelSecrets.put/replace, clear input, keep only credentialId
  - S4: Step 3/4 (pick models)
    - Search box, Refresh button
    - Model checkboxes with context/capabilities
    - Non-chat models collapsible section
    - Manual ID entry
    - Already-added models disabled
  - S5: Step 4/4 (capabilities and placement)
    - Tools/Vision/Thinking/Context/MaxOutput/Temperature settings
    - Probe button for tools
    - Checkboxes: add to default chain, make default model
    - Local model note (needs cloud for build/planning features)
  - S6: Edit provider dialog
    - All S3 fields + protocol read-only
    - Replace key, Remove key buttons
    - Enable toggle
    - Delete provider button with cascade confirm
  - S7: Edit model dialog
    - S5 fields + Remote id (read-only), Tags, Limits (rpm/rpd/tpm/tpd)
    - Test, Delete buttons
    - Delete validation (can't delete default without choosing replacement)
  - S8: Chain editor (part of S1)
    - Chain select (Default / Coding)
    - Drag to reorder, Alt+Up/Down keyboard
    - Add to chain picker
    - Helper text
  - S9: Composer/sidebar model select
    - Optgroups: Local / Cloud
    - Option text: "label — provider label"
    - Hide disabled models
    - Show "(not registered) name" for legacy values
  - All copy EXACTLY as specified in Arabic (shipped) + English (reference)
  - RTL layout
  - All async buttons show spinner and disable during operation
  - All destructive actions confirm
  - Cards never clipped, spaced apart
- [ ] 6.2: Create `ui/models-settings.css`
  - RTL-friendly layout
  - Card spacing, no clipping
  - Status chips styling
  - Capability badges
  - Drag handle styling
  - Step wizard navigation
  - Form layouts
  - Responsive design
- [ ] 6.3: Update `ui/index.html`
  - Add models-settings screen to app structure
  - Link from Settings menu
- [ ] 6.4: Update `ui/app.js`
  - Update existing model select code to use GET /api/models entries[]
  - Support optgroups (Local/Cloud)
  - Show provider label with model label
  - Handle legacy values with "(not registered)" prefix
- [ ] 6.5: Create `ui/models-settings.ar.json` and `ui/models-settings.en.json` (if not using inline copy)
  - All UI strings from spec §6 in exact Arabic/English
- [ ] 6.6: Manual walkthrough of S1-S9
  - Test all screens load
  - Test navigation through wizard
  - Test add provider flow
  - Test edit provider
  - Test delete provider with cascade
  - Test add models
  - Test edit model
  - Test delete model
  - Test chain reordering (mouse drag + Alt+Up/Down)
  - Test default/fallback model selection
  - Test re-import from config.json
  - Test model select in composer/sidebar
- [ ] 6.7: Verify key handling security
  - Keys never appear in UI after being set
  - Password fields have eye toggle
  - Input cleared immediately after put/replace
  - Only credentialId stored in draft
  - Cancel deletes unsaved draft credential
- [ ] 6.8: Verify no sparkle/star AI icons anywhere
- [ ] 6.9: Verify cards never clipped and properly spaced
- [ ] 6.10: Verify RTL layout works correctly
- [ ] 6.11: Commit phase 6 changes

**Exit Criteria:** Manual walkthrough + E1-E4 tests pass

---

## Phase 7: E2E, Security Sweep, Windows QA, Docs
**Goal:** Playwright tests, security verification, acceptance tests, documentation

### Tasks
- [ ] 7.1: Create `tests/e2e/stubs/` directory for fake servers
  - Fake Ollama server (/api/tags, /api/chat)
  - Fake OpenAI-compatible server (/v1/models, /v1/chat/completions with tool call)
  - Fake Anthropic server
  - Fake Gemini server
  - Closed port for "FreeLLMAPI down" test
- [ ] 7.2: Create `tests/e2e/model-registry.spec.ts` per spec §10.2
  - E1: Add Ollama -> models listed -> save -> visible in S1 and sidebar
  - E2: Add Custom OpenAI-compatible with key -> "Connected" -> pick 2 -> save
    - Verify data/model-registry.json exists and has no key
    - Verify config.json has no key
    - Verify userData/model-secrets/*.dpapi exists
  - E3: Add FreeLLMAPI while down -> error message -> "Save disabled" -> disabled provider
  - E4: /models returns 500 -> manual id entry works
  - E5: Reorder chain, first entry 503 -> second answers -> failover notice visible
  - E6: Replace key; delete provider with cascade -> chains updated
  - E7: Anthropic and Gemini stubs -> agent run with tool call round-trip
  - E8: Upgrade test: legacy config.json with cloudModel.apiKey
    - First launch migrates
    - config.json.pre-registry.bak exists
    - Key removed from config.json
    - Run picks same model as before upgrade
  - E9: Security sweep
    - Grep logs dir for fake key -> 0 hits
    - Grep data/ for fake key -> 0 hits
    - Grep config.json for fake key -> 0 hits
    - Capture HTTP responses, grep for fake key -> 0 hits
- [ ] 7.3: Create `docs/model-registry/user-guide.ar.md`
  - Arabic user guide for Settings > Models
  - How to add providers
  - How to add models
  - How to manage keys
  - How to configure chains
  - Troubleshooting common issues
- [ ] 7.4: Create `docs/model-registry/user-guide.en.md`
  - English version of user guide
- [ ] 7.5: Create `docs/model-registry/architecture.md`
  - Technical overview of registry system
  - Data flow diagrams
  - Security model
  - Migration strategy
  - Adapter architecture
- [ ] 7.6: Create `docs/model-registry/acceptance.md` template for A1-A14
  - A1: Upgrade with no visible change until Settings > Models opened
  - A2: Live Ollama models listed
  - A3: LM Studio or llama.cpp added and chats
  - A4: FreeLLMAPI added, when stopped falls back within ~5s
  - A5: OpenRouter key added via UI, config.json holds no key
  - A6: Anthropic chat with tool call
  - A7: Gemini chat
  - A8: LongCat chat
  - A9: OpenCode Go chat (resolves U-L3)
  - A10: z.ai chat after URL confirmed
  - A11: Wrong key shows Arabic "key rejected" message
  - A12: Default/fallback persist after restart
  - A13: Search %APPDATA% logs for key fragment -> none
  - A14: start-web.bat mode still works with env keys
  - Template with checkboxes and notes fields
- [ ] 7.7: Run all E2E tests - must pass
- [ ] 7.8: Run `npm run typecheck` - must pass
- [ ] 7.9: Run all unit tests - must pass (no worse than before)
  - Note any pre-existing jszip/pdfjs-dist test issues
- [ ] 7.10: Commit phase 7 changes
- [ ] 7.11: Run security sweep on entire codebase
  - Search for "sk-test-REDACTED-0000" in logs, data, config -> verify it's redacted
  - Verify no real keys in any committed files
  - Verify no keys in terminal output or error messages

**Exit Criteria:** E1-E9 green, docs complete, A1-A14 recorded

---

## Final PR Preparation

### Tasks
- [ ] PR.1: Review all commits in phase order
- [ ] PR.2: Verify branch name: `feat/model-registry`
- [ ] PR.3: Verify all phases 0-7 complete
- [ ] PR.4: Run full test suite one final time
  - `npm run typecheck`
  - `npm run test:unit`
  - E2E tests
  - All existing llm tests
- [ ] PR.5: Create PR body with:
  - Summary of what was implemented
  - Gemini implementation choice + justification
  - List of verified endpoints with sources
  - What was tested and how
  - Known remaining issues (if any)
  - Pre-existing test issues noted (jszip/pdfjs-dist)
  - Security verification summary
  - Acceptance test results (or note they're pending owner testing)
- [ ] PR.6: Create PR against main (DO NOT MERGE)
- [ ] PR.7: Verify PR includes all required files
- [ ] PR.8: Verify no sensitive data in PR (keys, secrets, credentials)

---

## Review Section

### Summary of Changes
*To be filled after completion*

### What Was Verified
*To be filled after completion*

### What Works
*To be filled after completion*

### Known Issues / Remaining Work
*To be filled after completion*

### Pre-existing Test Issues
*To be filled after completion*

### Security Notes
*To be filled after completion*

### Testing Notes
*To be filled after completion*

