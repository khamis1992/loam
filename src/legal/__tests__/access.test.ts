import assert from "node:assert/strict";
import { test } from "node:test";
import type http from "node:http";
import { assertMatterAccess, legalActor, reviewerFor, type LegalIdentityProvider } from "../security/access.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";
import type { Matter } from "../types.js";

const analyst: EnterpriseIdentity = { id: "analyst-1", tenantIds: ["qatar"], roles: ["analyst"], authMethod: "oidc", name: "محلل", licenseNo: "QA-1" };
const provider: LegalIdentityProvider = { tenantId: "qatar", verifier: { verify: async (token) => token === "valid" ? analyst : { ...analyst, roles: ["admin"] } } };
const request = (authorization?: string): http.IncomingMessage => ({ headers: authorization ? { authorization } : {} } as http.IncomingMessage);

test("Legal access keeps the local desktop identity and enforces signed enterprise roles", async () => {
  assert.equal((await legalActor(request(), undefined, "GET", ["status"])).authMethod, "local");
  await assert.rejects(() => legalActor(request(), provider, "GET", ["status"]), (error: unknown) => (error as { status: number }).status === 401);
  assert.equal((await legalActor(request("Bearer valid"), provider, "GET", ["status"])).id, "analyst-1");
  await assert.rejects(() => legalActor(request("Bearer valid"), provider, "POST", ["import"]), (error: unknown) => (error as { status: number }).status === 403);
  assert.equal((await legalActor(request("Bearer admin"), provider, "POST", ["import"])).roles[0], "admin");
});

test("signed reviewer identity ignores form spoofing and requires licence claims", () => {
  const reviewer = reviewerFor(analyst, { reviewerName: "منتحل", licenseNo: "fake" });
  assert.deepEqual(reviewer, { name: "محلل", licenseNo: "QA-1" });
  assert.throws(() => reviewerFor({ ...analyst, licenseNo: undefined }, {}), /licence claims/);
  assert.deepEqual(reviewerFor({ id: "local", tenantIds: ["local"], roles: ["admin"], authMethod: "local" }, { reviewerName: "محلي", licenseNo: "QA-local" }), { name: "محلي", licenseNo: "QA-local" });
});

test("matter access is limited to its owner, assigned reviewers and administrators", () => {
  const matter = { id: "m", ownerId: "owner", assignedReviewerIds: ["assigned"] } as Matter;
  assert.doesNotThrow(() => assertMatterAccess(matter, { ...analyst, id: "owner" }));
  assert.doesNotThrow(() => assertMatterAccess(matter, { ...analyst, id: "assigned" }));
  assert.doesNotThrow(() => assertMatterAccess(matter, { ...analyst, roles: ["admin"] }));
  assert.throws(() => assertMatterAccess(matter, analyst), /not assigned/);
});
