# SARIF source locations — revision 17

Source findings now export SARIF `locations[].physicalLocation` with a workspace-relative artifact URI, `uriBaseId: SRCROOT` and one-based `region.startLine`. Each result includes a consistent `ruleIndex`. Existing fingerprints, review confidence, workflow state and evidence identifiers remain in the export.

Unicode, spaces and URI-reserved filename characters are encoded per path segment. Absolute paths, network URLs, traversal, empty/dot path segments, invalid line numbers and malformed Unicode are not emitted as physical source links. The original target remains in result properties for review. HTTP findings are not misrepresented as local source files. Consumers may map `SRCROOT` to their own repository checkout; the export does not publish the machine's absolute workspace location as an artifact base.

Failed/incomplete checks appear in `invocations[].toolExecutionNotifications`, with `executionSuccessful: false` when the findings include an error. They are not relabeled as vulnerability findings. This preserves source-coverage failure visibility when a log has no vulnerability results. The exporter still does not claim full analysis coverage, automatically upload to a hosted service, or emit unreviewed code fixes.

Validation:

```
npx tsx src/scripts/check-security-sarif.ts
npx tsx src/scripts/check-security-sarif.ts output/verification/sarif-schema-2.1.0.json output/verification/sarif-validator
```

The second form uses a separate test-only installation of `ajv-draft-04` and `ajv-formats`. Both commands passed. Populated, empty and incomplete logs passed the official OASIS SARIF 2.1.0 schema with format validation. Schema obtained from `oasis-tcs/sarif-spec`, SHA256 `C3B4BB2D6093897483348925AAA73AF03B3E3F4BD4CA38CEF26DCB4212A2682E`. Generated fixture: `output/verification/security-sarif.json`.

HTTP integration tests verify actual source findings export `query.ts:1` and preserve incomplete-analysis notification semantics. Repository typecheck and server build passed on the current 0.5.15 worktree; the previously reported slide-test typecheck failure is no longer present.

Specification: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html (artifactLocation, physicalLocation, region and invocation objects).
Schema source: https://github.com/oasis-tcs/sarif-spec/blob/main/sarif-2.1/schema/sarif-schema-2.1.0.json

Schema validity establishes structural interoperability for the tested exports, not successful ingestion by every SARIF consumer. Hosted code-scanning upload has not been exercised.

Installed revision 17 on Loam 0.5.15 preserved 53 tasks and the profile. Installed UI/API regression passed, including source SARIF locations, incomplete execution notification, evidence and retest persistence. Backup: `output/verification/security-runtime-backup-20261018-111853`. UI test artifacts: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-tGtlCT`.
