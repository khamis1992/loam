# Red-team report — RED-mvqne9n1-1

- Campaign goal: Engagement 2026-10-27T12:14:39.948Z on http://127.0.0.1:5195/nutrio/
- Authorization: AUTHZ-0001
- Window: 2026-10-27T12:14:39.949Z → 2026-10-27T12:21:07.801Z (2 request(s), 1 target(s))
- Findings: 2 proven, 6 unverified

## 1. [MEDIUM] Missing response security headers can enable injection or clickjacking

- Check: `security_headers`
- Target: http://127.0.0.1:5195/nutrio/
- Detail: Missing Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy on HTTP 200
- PoC artifact: `poc/005e1dc4379411600109c43a.json`

## 2. [LOW] Hidden content discovered by fuzzing (60 path(s))

- Check: `red_fuzz_discovery`
- Target: http://127.0.0.1:5195/nutrio/
- Detail: /admin -> HTTP 200; /administrator -> HTTP 200; /api -> HTTP 200; /assets -> HTTP 200; /auth -> HTTP 200; /backup -> HTTP 200; /bin -> HTTP 200; /cgi-bin -> HTTP 200; /config -> HTTP 200; /console -> HTTP 200; /dashboard -> HTTP 200; /db -> HTTP 200; /debug -> HTTP 200; /dev -> HTTP 200; /docs -> HTTP 200; /downloads -> HTTP 200; /env -> HTTP 200; /etc -> HTTP 200; /git -> HTTP 200; /health -> HTTP 200
- Remediation: Remove or protect content that should not be reachable; deny-list common backup/hidden paths.
- PoC artifact: `poc/3cb7f2e76305ebb75e6d32be.json`

## Unverified claims (withheld by the evidence gate)

- **Server-side request forgery confirmed by an OOB callback** (`red_ssrf` @ http://127.0.0.1:5195/nutrio/) — validation failed: SSRF case path is outside the approved scope
- **Node endpoint deserializes attacker-controlled bytes** (`red_deser_node` @ http://127.0.0.1:5195/nutrio/) — validation failed: Deserialization case path is outside the approved scope
- **SQL injection in target parameters** (`red_sqli` @ http://127.0.0.1:5195/nutrio/) — status is "refuted", not "confirmed": sqlmap found no injectable parameter
- **Active DAST scan findings** (`red_dast` @ http://127.0.0.1:5195/nutrio/) — status is "inconclusive", not "confirmed": ZAP daemon scan failed: ZAP daemon did not become ready (last HTTP 0)
- **Known-CVE/misconfig template matches** (`red_templates` @ http://127.0.0.1:5195/nutrio/) — status is "refuted", not "confirmed": no template matched at >= low: (no engine output)
- **Endpoint deserializes attacker-controlled bytes** (`red_deser` @ http://127.0.0.1:5195/nutrio/) — status is "refuted", not "confirmed": delivery returned HTTP 404 without a deser marker

## Execution coverage

- red.ssrf @ http://127.0.0.1:5195/nutrio/ — **error**: SSRF case path is outside the approved scope
- red.deser.node @ http://127.0.0.1:5195/nutrio/ — **error**: Deserialization case path is outside the approved scope
- red.sqli @ http://127.0.0.1:5195/nutrio/ — **covered**
- red.dast @ http://127.0.0.1:5195/nutrio/ — **partial**: status is "inconclusive", not "confirmed"
- red.fuzz @ http://127.0.0.1:5195/nutrio/ — **covered**
- red.templates @ http://127.0.0.1:5195/nutrio/ — **covered**
- red.deser @ http://127.0.0.1:5195/nutrio/ — **covered**
