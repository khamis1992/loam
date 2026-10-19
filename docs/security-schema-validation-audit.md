# Schema-validation assumptions audit

This audit corrects the revision-24 claim that all three unmatched candidates in `json-schema-validator.js` are known over-reports. Runtime schema behavior supports that classification for the Joi fixture, but not for the two Ajv fixtures.

## Reproducible evidence

Run `npx tsx src/scripts/check-security-schema-assumptions.ts`. Test-only dependencies are pinned in `output/verification/schema-runtime`: Ajv **8.20.0** and Joi **18.3.0**, installed with scripts disabled. They are not application dependencies. The result is written to `output/verification/security-schema-assumptions.json` with versions, schemas, per-case outcomes and interpretation. Only trusted local schema fixtures are compiled; no imported reference application or database operation is executed.

| Probe | Actual behavior |
| --- | --- |
| Reference Ajv object schema, unknown `$or` or `$expr` key | Accepted; key retained |
| Same schema with `additionalProperties: false` | Unknown keys rejected |
| Object supplied to declared string property | Rejected by both Ajv variants |
| Empty object | Accepted by both; no fields are required |
| Closed root with an unrestricted nested object property | Operator-shaped nested object accepted |
| Validate a string, then JSON.parse it | String validation does not constrain the decoded object's operators |
| Reference Joi required-string schema, unknown key alongside valid fields | Rejected with `object.unknown` |
| Same Joi schema with `.unknown(true)` | Unknown key accepted |
| Joi validation error | Returned value still contains the rejected input; using it despite error is not safe filtering |

These observations concern schema acceptance, not successful database exploitation. MongoDB server settings, receiver type, query semantics and authorization still matter. A closed scalar filter can also be empty and match more records than intended; operator restrictions do not prove access control.

## Corrected interpretation of the pinned development corpus

- `json-schema-validator.js:27` and `:30`: the Ajv schema omits `additionalProperties: false`. A successful check does not exclude additional query-operator keys. These candidates must remain under review, rather than be suppressed as known false positives.
- `json-schema-validator.js:53`: the Joi fixture's successful validation rejects the tested operator-object forms. The existing syntactic detector does not model that guard, so it remains a known over-report for these verified semantics. General Joi suppression is not justified: unknown-field options, schema shape, validation errors and subsequent decoding/mutation can change behavior.
- `hana.js:93` and `:94`: still unadjudicated.

The original external expected file and denominator are unchanged. Location overlap remains **57/158**, with five unmatched candidates. The audit changes our interpretation of the five; it does not manufacture a higher score. The corpus is a development set, not independent certification.

The source regression explicitly retains warnings for the open Ajv schema. No blanket sanitizer exemption was added, and no runtime security engine reinstall was needed for this audit. Next guard modeling must check library provenance, schema closure at relevant nesting levels, successful-branch dominance, mutation after validation and decoded data; merely seeing a function named validate is insufficient.

Primary reference: [Ajv additionalProperties](https://ajv.js.org/json-schema.html#additionalproperties). The executable fixture results above are the authoritative evidence for the pinned versions used in this audit.
