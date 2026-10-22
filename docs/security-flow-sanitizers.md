# Sanitizer modeling and static→dynamic linking — revision 60

Two section-13 increments on the cross-file flow engine (`src/security/source-flow.ts`):

## 1. Sanitizer/validator modeling (cutting sanitized flows)

The propagator now models sanitizers and validators: when the value flows through a call whose callee name matches a bounded sanitizer family — `escapeHtml`/`htmlEscape`/`escape`/`encode*`/`encodeURIComponent`/`encodeURI`, `sanitize*`/`purify*`/`clean*`/`strip*`/`normalize*`, coercions `parseInt`/`parseFloat`/`Number`/`Boolean`/`isNumeric`/`isInt`/`isFinite`, and `valid*`/`escapeJavaScript` — the result is treated as clean:

- `const safe = escapeHtml(req.query.q)` no longer taints `safe` (previously every flow continued regardless of sanitization — a documented over-approximation);
- reassignment `q = sanitize(q)` **untaints** `q`;
- every cut is counted in `flowScan.sanitized`, and the finding text reports how many sanitizer calls were modeled.

This is name-based modeling, not proof of a correct sanitizer: a custom `escapeHtml` that is itself broken still cuts the flow, so sanitized chains belong to review too — but now via deliberate omission recorded in the counts, rather than silent over-reporting.

## 2. Static→dynamic linking

`linkFlowsToDynamicEvidence(flows, routes, dynamicFindings)` joins each static flow with live proofs from the same campaign: a flow whose **source file also declares a route** (via the existing route scan) is linked to any dynamic finding (`injection_*`, `xss_*`, `traversal_*`, `ssrf_*`, `template_*`, `xxe_*`, `deser_*`, `command_*`, `redirect_*`) whose proven target URL path equals that route. The link:

- is stored on the assessment as `flowScan.links` (`{sink, route, url, check}`);
- rides the `source_flow` finding detail: "Dynamic evidence on the same route: injection_… observed on http://…/search (route /search). The static hop chain and the live proof describe the same surface from both directions.";
- keeps the finding at review confidence — linking elevates context, never the verdict;
- disappears on a repaired retest (no live finding left to link).

## Honest limits

- Sanitizer matching is by callee name only; aliasing, custom-named encoders and schema-validation libraries (zod/Joi/validator.js methods) are not recognized, and a wrongly implemented sanitizer still cuts the flow (name says clean; the engine does not verify semantics).
- Linking matches route path equality between the flow's source file and dynamic target URLs; parameterized route templates, router mounts and cross-origin API paths (where the flow's source file and the live URL's frontend origin differ) are not linked.
- Control-flow-dependent sanitization (`if (!valid(x)) return;` guards) is not modeled.

## Validation

`npm run check:security-flow-link` builds two real workspaces plus a live campaign: the dirty chain (`req.query.q` → imported `lookup` → `db.query` in another file) reports one sql_like flow with zero sanitizer cuts; the sanitized chain (the same value through `escapeHtml`) reports **zero** flows with one counted sanitizer; the campaign proves SQL injection dynamically on `/search` (boolean differential) while `includeSource` finds the flow in the same workspace — exactly one link joins the flow sink to the live finding, the note rides the static finding, and after a repaired retest the link clears with the dynamic finding. All 34 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
