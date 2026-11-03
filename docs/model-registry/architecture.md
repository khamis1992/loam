# Model registry architecture

The registry is the list of providers, models, and failover chains. Chat runs still go through the existing failover client. The registry compiles into that shape at request time.

## Data

| Piece | Location | Contents |
| --- | --- | --- |
| Registry | `data/model-registry.json` | Providers, models, chains, default ids. No secrets. |
| Backup | `data/model-registry.json.bak` | Previous file, written before each save. |
| Config backup | `config.json.pre-registry.bak` | Written once when a legacy config is migrated. |
| Vault | Electron `userData/model-secrets/<uuid>.dpapi` | DPAPI ciphertext. `index.json` stores a hint only. |

`src/models/registry/schema.ts` checks the file on load and save: slug ids, http(s) URLs, model ids of the form `providerId/remoteId`, and no secret headers in `extraHeaders`.

## Request path

1. Agent Studio sends the chosen model on the task (`extData.runModel`). A tier name is used only when no concrete model was remembered.
2. `src/protocol/socket.ts` prefers that concrete model over `modelTier`.
3. A `registry:` ref is resolved by `src/models/registry/registryClient.ts` to the provider record and the remote id.
4. The adapter (Ollama, OpenAI-compatible, Anthropic, or Gemini) is built with the vault or env key. The key is not written to the registry.
5. `src/llm/failover.ts` compiles the `default` chain. A vault-backed provider stays in the chain. On an unavailable response it moves to the next provider.

`GET /api/models` keeps the live probed `models` list and adds `entries` from the saved registry (id, label, provider, location, enabled, capabilities).

## Auth

| Kind | Header |
| --- | --- |
| `none` | No key |
| `bearer` | `Authorization: Bearer` |
| `header` | Named header. Anthropic uses `x-api-key`. Gemini uses `x-goog-api-key`. |
| `env` | Named environment variable. Used when the desktop vault is unavailable. |

`POST /api/model-registry/providers` sends the pasted key to the vault and stores the returned UUID. The response is redacted.

## Migration

On first startup with no registry file, `initializeRegistry` copies providers from `config.json` into the registry and moves desktop keys into the vault. Later startups load the registry file. Legacy `:cloud` model names still select the Flex Ollama cloud client.

## Adapters

`src/models/adapters/` speaks each protocol and returns Loam's chat result. Listing models reads the provider's catalog (`/api/tags`, `/models`, or the Gemini list). A failed list throws; it does not look like an empty catalog.

Gemini is a native adapter, not an OpenAI-compatible translation.
