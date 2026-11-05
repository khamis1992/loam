# Loam Build

Use `web_scaffold`, the existing preview service and app-builder tools. `site_init` attaches one project; `site_attach` recovers it without duplicating. `site_checkpoint` records real file hashes and never creates a Git commit or tag.

Secrets are names only. Direct the user to the existing App Builder host form with `site_secrets_request`; never place secret values in chat, manifests or logs. `site_publish_request` is host-only and waits for a real approval before calling `deploy_app`.
