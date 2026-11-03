import type { EngineLicenseClass } from "./registry.js";

export function licensePolicy(licenseClass: EngineLicenseClass): { externalProcess: "allowed" | "legal-review-required"; embedding: "legal-review-required" } {
  if (licenseClass === "permissive") return { externalProcess: "allowed", embedding: "legal-review-required" };
  return { externalProcess: "legal-review-required", embedding: "legal-review-required" };
}

export function assertExternalLicense(licenseClass: EngineLicenseClass, reviewed: boolean): void {
  const decision = licensePolicy(licenseClass);
  if (decision.externalProcess === "legal-review-required" && !reviewed) throw new Error("license review is required before external execution");
}
