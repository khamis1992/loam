/** User lookup helpers. */

import { normalizeKey } from "./text.js";

export function lookupKey(email) {
  return normalizeKey(email);
}

export function canonicalize(emails) {
  return emails.map((email) => normalizeKey(email)).sort();
}
