/**
 * Shared kill-switch controller used by the agent tool, HTTP route and the
 * security-page button. Engagement is always audited (§5.5).
 */
import { RedAuditLog } from "./audit.js";
import { configureSharedKillState, defaultDataRoot, engageKillSwitch, resetKillSwitch, sharedKillSwitchEngaged } from "./gate.js";
import { SharedKillSwitch } from "../enterprise/killSwitch.js";

export function setRedKillSwitch(engage: boolean, root?: string): { engaged: boolean } {
  const dataRoot = root ?? defaultDataRoot();
  const shared = new SharedKillSwitch(dataRoot);
  configureSharedKillState(() => shared.read().engaged);
  shared.set(engage, "local-operator");
  const audit = new RedAuditLog(dataRoot);
  if (engage) {
    engageKillSwitch();
    audit.append({
      authzId: null,
      capability: "red.control",
      action: "kill-switch",
      target: "all-red-actions",
      params: {},
      outcome: "killswitch_engaged",
      reason: "operator engaged the kill-switch",
    });
  } else {
    resetKillSwitch();
    audit.append({
      authzId: null,
      capability: "red.control",
      action: "kill-switch-reset",
      target: "all-red-actions",
      params: {},
      outcome: "allowed",
      reason: "operator reset the kill-switch",
    });
  }
  return { engaged: sharedKillSwitchEngaged() };
}
