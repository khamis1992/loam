# OpenAPI fixtures and coverage — revision 9

OpenAPI import now retains a per-operation discovery plan instead of silently dropping parameterized or unsupported operations. The contract follows path templating and parameter inheritance described by the official specification: https://spec.openapis.org/oas/v3.1.2.html . This is a bounded discovery feature, not a complete OpenAPI validator or schema fuzzer.

Use campaign mode and supply explicit synthetic identifiers through the UI or `openapiFixtures`:

```json
{
  "/records/{id}": [{"id":"fixture-a"},{"id":"fixture-b"}]
}
```

The imported GET operation must declare each template parameter with `in: "path"` and `required: true`, on the path item or the operation. Operation definitions override path-level parameters by name and location. Values are not taken from arbitrary schema examples/defaults. Up to ten sets per path and 500 generated URLs are supported; values are restricted to simple non-traversing segments. Generated paths must remain inside approved scope and are persisted as evidence, so use synthetic identifiers rather than confidential personal values.

The asset coverage tab shows declared operations, generated routes, routes actually requested, successful HTTP responses and reasons for exclusion. Non-GET methods, unresolved references, missing fixtures, required non-path parameters, request bodies and excluded paths remain visible. External `servers` and references are never fetched. Configure POST and complex inputs through explicit browser flows instead. HTTP success does not prove authorization or vulnerability absence, and overall completion of selected checks does not imply every imported operation was supported.

Retests preserve the generated route list and operation plan without requiring the original OpenAPI upload. Resource/page limits can leave routes unrequested; the coverage table reports that distinction. The UI refuses to use this feature with a server older than revision 9.

Validation: `npm run check:security-openapi` sends requests to a local fixture and checks exact generated routes, exclusions, invalid fixtures, skipped operations, no external reference fetch, preserved retest plans and page-limit coverage. `npm run check:security-http` verifies upload and fixture input reach the server. No real Nutrio API identifiers were generated or scanned by these tests.
