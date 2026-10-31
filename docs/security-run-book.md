# Run book: shared threat model, coverage, recording proxy, budget pause, lazy MCP

These five surfaces close the "campaign management" gap between Loam's scanners
and a full engagement: the frame the fleet tests against is shared and auditable,
every assessed surface is recorded (including the clean ones), traffic can be
captured and replayed as evidence, a run can be parked instead of killed, and a
large MCP catalogue costs no context until it is used.

| Surface | Tools | Store |
| --- | --- | --- |
| Shared threat model | `threat_model_get`, `threat_model_save`, `threat_model_amend` | `threat_models` table, one document per task |
| Coverage ledger | `coverage_record`, `coverage_update`, `coverage_list`, `coverage_report`, `coverage_delete` | `coverage_entries` table, unique per task+target+check |
| Recording proxy | `proxy_start`, `proxy_status`, `proxy_list_requests`, `proxy_view_request`, `proxy_repeat_request`, `proxy_scope`, `proxy_stop` | `.loam-proxy/<task>.json` in the workspace |
| Budget pause | `budget_pause`, `budget_resume`, `budget_status`; `POST /api/sessions/:id/budget-pause` / `-resume` | in-process, epoch-guarded |
| Lazy MCP | `mcp_list_servers`, `mcp_search_tools`, `mcp_tool_schema`, `mcp_call_tool` | per-server `"lazy": true` in `mcpServers` |

## Threat model

The model is scan-scoped and shared. Save it once before testing; a child agent
reads the same document. When testing disproves an assumption, amend it — do not
keep a private copy. `save` replaces the document, `amend` merges actors, assets
and boundaries by name and appends assumptions and notes.

## Coverage ledger

Record every surface assessed, including clean ones: a `covered` entry with zero
findings is the negative space that makes a "done" claim auditable. A surface
that did not finish is `partial`; a scanner failure is `error`. `coverage_report`
returns the open proof gaps, the cleared negative space and findings by target.
Re-recording the same target+check refreshes the entry instead of duplicating.

## Recording proxy

`proxy_start` listens on loopback and records each exchange with a stable id
(`px_N`) under `.loam-proxy/<task>.json`. Point a client at it with
`HTTP_PROXY`/`HTTPS_PROXY` or `curl -x`. Plain HTTP is recorded in full; HTTPS is
tunneled with CONNECT (target and byte counts recorded, bodies not). A finding
validated over HTTP should cite the proving exchange and its control exchange;
`proxy_repeat_request` produces the variant and keeps `parentId` pointing at the
original. `proxy_scope` restricts the hosts allowed through.

## Budget pause

A pause is not a stop. The run parks before its next model call, keeps the
transcript and the mission checkpoint, and `budget_resume` continues from the
same step — raise the ceiling first when the budget itself tripped. The wait is
epoch-guarded so a resume landing in the same tick is not lost, a newer pause
keeps the run parked, and a stop always wins over a resume.

## Lazy MCP

Mark a server `"lazy": true` in `mcpServers` to keep its tool schemas out of the
prompt. `mcp_search_tools` loads the catalogue on first use; `mcp_tool_schema`
returns one input schema; `mcp_call_tool` dispatches by name. Per-server
allowlists, policy hooks and the rea/cua allowlists still apply.
