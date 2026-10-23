/** Display helpers for the activity feed. */

export function describeCount(n) {
  const label = n === 1 ? "item" : "items";
  return n + " " + label;
}

export function displayName(user) {
  const name = user === null || user === undefined ? "anonymous" : user.name;
  return name;
}
