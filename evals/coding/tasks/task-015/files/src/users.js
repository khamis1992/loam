/** User lookup helpers. */

export function lookupKey(email) {
  return String(email).trim().toLowerCase();
}

export function canonicalize(emails) {
  return emails.map((email) => String(email).trim().toLowerCase()).sort();
}
