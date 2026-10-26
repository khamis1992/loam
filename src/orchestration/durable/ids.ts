import { randomBytes } from "node:crypto";

/** Sortable, collision-safe ids: `<prefix>_<time base36><8 hex>`. */
export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now.toString(36)}${randomBytes(4).toString("hex")}`;
}
