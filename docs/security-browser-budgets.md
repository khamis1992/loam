# Browser loading budgets — runtime revision 8

The UI now exposes per-response bytes, cumulative bytes, readiness timeout and network-idle timeout. Defaults remain 2 MB per response, 20 MB per campaign, 10 seconds readiness and 5 seconds network idle. MB means 1,000,000 decompressed bytes.

Server-enforced limits: response 100,000–10,000,000 bytes; campaign 1,000,000–200,000,000 bytes; readiness 1–60 seconds; network-idle 1–30 seconds. Response limit cannot exceed campaign limit. The campaign deadline and request quota still apply. Bytes read from rejected responses count toward the cumulative budget; a streaming chunk can cross the limit before reading is stopped.

Saved browser evidence includes resource totals and configured limits. An incomplete render includes its last loading stage (navigation, readiness, networkidle or document-complete), failed and blocked counts, runtime error count and timeout settings. Retesting preserves the original limits. Increasing a budget requires a new baseline rather than silently changing retest conditions.

## Nutrio evidence, 2026-10-18

Run `5ef483da-e976-4460-b104-edf63cf68866` was executed with the current source engine against the existing local server at `http://127.0.0.1:5173/`. No credentials or external API grants were supplied. Target screenshots were disabled.

- 718 requests; 43,732,376 bytes received by the browser.
- Limits: 10 MB per response, 100 MB total, readiness 30 seconds, network idle 10 seconds.
- Sign-in form flow: all four steps completed, zero failed HTTP resources.
- Render: HTTP 200, application readiness selector visible, document complete, network settled, zero runtime errors, zero failed resources.
- Overall result remains partial: six Vite WebSocket requests blocked. Initial HTTP-only root inspection sees a 301 and does not follow it; the browser follows the separately authorized document redirect.
- This establishes anonymous application loading. It does not establish successful login, authenticated API coverage, authorization correctness or absence of vulnerabilities.

Evidence: `output/verification/nutrio-resource-result.json` and the task-local run under `output/verification/nutrio-resource-check/.loam/security/`.

Verification: `npm run check:security-resource-budgets` proves cumulative limits, failed-response accounting, explicit readiness failures, successful loading after increasing budgets and unchanged retest configuration. `npm run check:security-http` proves UI values reach the server. TypeScript and server build passed. Installed desktop runtime has not been updated in this step.
