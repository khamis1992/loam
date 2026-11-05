# Red-team report — RED-mvr4bfv4-1

- Campaign goal: Engagement 2026-10-27T20:08:21.519Z on http://localhost:5195/nutrio
- Authorization: localhost default posture
- Window: 2026-10-27T20:08:21.520Z → 2026-10-27T20:11:53.312Z (10 request(s), 1 target(s))
- Findings: 1 proven, 6 unverified

## 1. [LOW] Hidden content discovered by fuzzing (60 path(s))

- Check: `red_fuzz_discovery`
- Target: http://localhost:5195/nutrio
- Detail: /admin -> HTTP 200; /administrator -> HTTP 200; /api -> HTTP 200; /assets -> HTTP 200; /auth -> HTTP 200; /backup -> HTTP 200; /bin -> HTTP 200; /cgi-bin -> HTTP 200; /config -> HTTP 200; /console -> HTTP 200; /dashboard -> HTTP 200; /db -> HTTP 200; /debug -> HTTP 200; /dev -> HTTP 200; /docs -> HTTP 200; /downloads -> HTTP 200; /env -> HTTP 200; /etc -> HTTP 200; /git -> HTTP 200; /health -> HTTP 200
- Remediation: Remove or protect content that should not be reachable; deny-list common backup/hidden paths.
- PoC artifact: `poc/175ad553a43b78880c75b20a.json`

## Unverified claims (withheld by the evidence gate)

- **Server-side request forgery confirmed by an OOB callback** (`red_ssrf` @ http://localhost:5195/nutrio) — validation failed: SSRF case path is outside the approved scope
- **Node endpoint deserializes attacker-controlled bytes** (`red_deser_node` @ http://localhost:5195/nutrio) — validation failed: Deserialization case path is outside the approved scope
- **SQL injection in target parameters** (`red_sqli` @ http://localhost:5195/nutrio) — status is "refuted", not "confirmed": sqlmap found no injectable parameter
- **Active DAST scan findings** (`red_dast` @ http://localhost:5195/nutrio) — status is "refuted", not "confirmed": ZAP quick-scan reported no alerts
- **Known-CVE/misconfig template matches** (`red_templates` @ http://localhost:5195/nutrio) — status is "refuted", not "confirmed": no template matched at >= low: (no engine output)
- **Endpoint deserializes attacker-controlled bytes** (`red_deser` @ http://localhost:5195/nutrio) — status is "refuted", not "confirmed": delivery returned HTTP 404 without a deser marker

## Execution coverage

- red.ssrf @ http://localhost:5195/nutrio — **error**: SSRF case path is outside the approved scope
- red.deser.node @ http://localhost:5195/nutrio — **error**: Deserialization case path is outside the approved scope
- red.sqli @ http://localhost:5195/nutrio — **covered**
- red.dast @ http://localhost:5195/nutrio — **covered**
- red.fuzz @ http://localhost:5195/nutrio — **covered**
- red.templates @ http://localhost:5195/nutrio — **covered**
- red.deser @ http://localhost:5195/nutrio — **covered**
