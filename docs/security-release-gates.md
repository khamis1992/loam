# Security release gates

The required security release command is:

```powershell
npm run verify:security
```

The current manifest chain includes, in order:

- TypeScript with no `continue-on-error`.
- Red-team unit and integration tests.
- Scanner and normalization tests.
- Mobile unit tests and the independent parser benchmark.
- Enterprise policy, OIDC, encryption, queue, storage and HTTP tenant-isolation tests.
- The live localhost red-team lab.
- Mobile and enterprise acceptance commands.
- Expanded authorization/business scenarios, device-farm and investigation HTTP tests, integrations, SLO and signed encrypted DR restore tests.
- The 20-case mobile scale corpus and enterprise scale acceptance.
- Unified coverage, hypothesis budgets, GraphQL/WebSocket/SPA, instrumentation and signed-plugin unit and HTTP acceptance via `test:advanced` / `check:advanced`.
- SQLite vulnerability catalog seed, filters, authorized planning, disabled-action and unknown-validator acceptance via `test:catalog` / `check:catalog`.
- Atomic/CRS/Agentic AI, exposure, provenance, CBOM and channel acceptance via `test:next` / `check:next`.
- External engine license/scope/hash/timeout/idempotency and HTTP acceptance via `test:engines` and `check:engines`.
- The packaged ASAR security-surface check.

`.github/workflows/security-gates.yml` runs this chain on pushes to `main`, pull requests and manual dispatch, followed by the existing normalize, scanner, reverse-engineering, fuzz and self-scan gates. A failed typecheck or security test fails the job; there is no security `continue-on-error` path.

The older `src/scripts/verify-security.ts` runner remains available for repositories that register `check:security*` scripts in the manifest. The historical 36-gate result recorded on 2026-10-19 is not represented as a result for the current chain. Run `npm run verify:security` to produce current evidence.

External MobSF, physical Android/iOS devices, production OIDC/SAML, KMS and SIEM acceptance require their own configured environments. Offline CI uses local mock contracts and does not claim production certification.
