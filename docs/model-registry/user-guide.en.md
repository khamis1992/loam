# Model registry user guide

Loam keeps every model source in one registry: local Ollama, LM Studio, llama.cpp, and cloud APIs (OpenAI, OpenRouter, Anthropic, Gemini, and any OpenAI-compatible URL).

API keys are not stored in `config.json` or `data/model-registry.json`. On the desktop app they are encrypted with Windows DPAPI under the app's `model-secrets` folder. The registry stores only a credential id.

## Add a provider

1. Open Settings, then Models.
2. Choose Add provider.
3. Pick the type. The base URL fills in for known presets. Change it for a custom endpoint.
4. Paste the API key if the provider requires one. Leave it empty for local Ollama, LM Studio, or llama.cpp.
5. Test the connection, then save.

After save, the key field is cleared. The list shows a hint, not the key.

## Add models

1. Open the provider and choose Discover.
2. Select the models you want and save them.
3. If the provider's model list fails, type the remote id yourself.

The saved id is `providerId/remoteId`. A chat run uses the remote id with that provider's key.

## Pick a model for a chat

In Agent Studio, choose the model from the composer picker. The choice is sent as the concrete model for that message. A registry model is stored as `registry:<providerId>/<remoteId>`.

If the first provider in the default chain returns an unavailable response, Loam tries the next enabled model that has a usable key.

## Keys

- Replace a key from the provider editor. The previous secret is replaced in the vault.
- Delete a provider to remove its models from the chains. Deleting the provider does not print the key.
- Web mode (`start-web.bat`) has no DPAPI vault. Use an environment variable and an `env` auth entry instead.

## If a provider will not connect

- Local URL must be `http://127.0.0.1:<port>` (Ollama `11434`, LM Studio `1234`, llama.cpp `8080`).
- Cloud URL must be `https`.
- A rejected key means the provider refused the credential. Replace it and test again.
- A provider that is down can stay saved and disabled. The chain skips it.
