# Financial analytics engine (blueprint gap 3)

The blueprint's financial subsystem, delivered as a local-first engine plus a
key-less SEC EDGAR reader. No paid APIs, no account, nothing leaves the machine
except the public EDGAR requests.

## Layout

| Module | What it does |
|--------|--------------|
| `src/financial/core.ts` | Pure money math: NPV, IRR (bisection), CAPM, after-tax WACC, DCF (Gordon terminal, per-share value, terminal-reliance flag), full ratio card, amortization schedules, Benford first-digit law. |
| `src/financial/edgar.ts` | SEC EDGAR reader: ticker/CIK directory search, recent filings with archive links, and companyfacts XBRL distillation into a clean annual series (revenue, operating income, net income, OCF, assets, liabilities, equity, cash, R&D, debt, shares). Cached (24h directory, 15min documents) with a politeness queue; annual statements only — quarterly snapshots are filtered out; renamed tags are resolved by newest coverage. |
| `src/financial/audit.ts` | Structured red flags over the series: accounting identity (A = L + E), negative equity, cash cushion, leverage ramp, earnings quality (net income vs OCF), margin swings, R&D intensity. |

## Agent tools

`finance_dcf`, `finance_ratios`, `finance_npv_irr`, `finance_amortize` (local
math) · `finance_company`, `finance_filings`, `finance_audit` (EDGAR-backed) ·
`finance_benford` (Benford over any provided amounts — invoices, ledgers).

## Operating notes

- **User-Agent**: the SEC WAF 403s generic browser UAs and some mail domains
  (verified live: `users.noreply.github.com` is blocked). Default contact is
  `contact@example.com`; override with `LOAM_EDGAR_CONTACT="you@yourdomain.com"`.
- **Verified live** (2026-10-31): Apple FY2025 distills to revenue 416.161B,
  operating income 133.050B, net income 112.010B, OCF 111.482B, assets
  359.241B — matching the filed 10-K.
- **Caching**: the ticker directory (≈1 MB) is fetched once per 24h;
  submissions/companyfacts per company live 15 minutes. Tests never touch the
  network — the transport is injectable via `__setFetchForTests`.

## Gates

```
npm run test:financial   # core (8) + edgar (4) + audit (7) + tools (10), all offline
npm run check:financial  # typecheck + tests
```
