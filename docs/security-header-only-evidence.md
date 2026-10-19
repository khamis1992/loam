# Header-only HTTP checks — revision 28

Security-header, cookie-flag, server-banner, CORS and advertised-method checks now inspect the actual GET/OPTIONS response headers and cancel body consumption. They do not substitute HEAD, which can have different server behavior. A large or streaming body therefore does not prevent these header checks. Redirects and non-success statuses remain inconclusive.

Evidence explicitly records `bodyOmitted: true`, zero retained bytes and an empty body-hash field. No empty-content hash is presented as evidence of a body that was not read. Finding details and the request ledger distinguish header-only reads from truncated content. This does not claim zero network bytes: a client may buffer response bytes before cancellation.

Discovery, HTML inspection, directory listings, exposed-file signatures and legacy access comparisons still require the bounded body path. The revision 27 overflow protections remain active: a successful header check does not confer content coverage on the same URL or clear its missing content findings on retest.

Tests: the focused HTTP body suite verifies all five header checks on oversized responses (including cookie/CORS/method findings), GET/OPTIONS request semantics, a never-ending body after headers, redirects, persisted omission metadata, and the existing chunked/UTF-8/gzip/HEAD boundary and incomplete-retest cases. Campaign regression, typecheck and server build passed. HTTP/UI integration additionally checks the visible header-only evidence label and omitted hash.

Installed revision 28 on Loam 0.5.19. The guarded installer verified matching runtime files and preserved the profile and 84 existing tasks. Backup: `output/verification/security-runtime-backup-20261018-124106`. Both source-server and installed-runtime HTTP/UI suites passed; installed screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-68Mi32`, source screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-eZRUoq`. The focused campaign regression additionally asserts that security-header coverage is present while credential-form coverage remains absent for the oversized response.
