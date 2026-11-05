# Red-team report — RED-mvmwtlbi-1

- Campaign goal: Engagement 2026-10-24T21:27:26.765Z on http://127.0.0.1:3939
- Authorization: localhost default posture
- Window: 2026-10-24T21:27:26.766Z → 2026-10-24T21:30:39.281Z (6 request(s), 1 target(s))
- Findings: 1 proven, 8 unverified

## 1. [LOW] Hidden content discovered by fuzzing (60 path(s))

- Check: `red_fuzz_discovery`
- Target: http://127.0.0.1:3939
- Detail: /admin -> HTTP 401; /administrator -> HTTP 401; /api -> HTTP 401; /assets -> HTTP 401; /auth -> HTTP 401; /backup -> HTTP 401; /bin -> HTTP 401; /cgi-bin -> HTTP 401; /config -> HTTP 401; /console -> HTTP 401; /dashboard -> HTTP 401; /db -> HTTP 401; /debug -> HTTP 401; /dev -> HTTP 401; /docs -> HTTP 401; /downloads -> HTTP 401; /env -> HTTP 401; /etc -> HTTP 401; /git -> HTTP 401; /health -> HTTP 401
- Remediation: Remove or protect content that should not be reachable; deny-list common backup/hidden paths.
- PoC artifact: `poc/c7be981a060f53b127bc7594.json`

## Unverified claims (withheld by the evidence gate)

- **SSRF via metadata probe (http://169.254.169.254/latest/meta-data/)** (`red_ssrf` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": probe response did not contain a fetch marker
- **SSRF via metadata probe (http://169.254.169.254/latest/meta-data/iam/security-credent)** (`red_ssrf` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": probe response did not contain a fetch marker
- **SSRF via metadata probe (http://metadata.google.internal/computeMetadata/v1/)** (`red_ssrf` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": probe response did not contain a fetch marker
- **SSRF via fileRead probe (file:///etc/hostname)** (`red_ssrf` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": probe response did not contain a fetch marker
- **SSRF via fileRead probe (file:///c:/windows/win.ini)** (`red_ssrf` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": probe response did not contain a fetch marker
- **SQL injection in target parameters** (`red_sqli` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": sqlmap found no injectable parameter
- **Known-CVE/misconfig template matches** (`red_templates` @ http://127.0.0.1:3939) — status is "refuted", not "confirmed": no template matched at >= low
- **Endpoint deserializes attacker-controlled bytes** (`red_deser` @ http://127.0.0.1:3939) — status is "inconclusive", not "confirmed": ysoserial unavailable: exit code 70
