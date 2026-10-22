/** Display helpers for the activity feed. */

export function describeCount(n) {
  var label = n === 1 ? "item" : "items";
  return n + " " + label;
}

export function displayName(user) {
  var name = user == null ? "anonymous" : user.name;
  return name;
}
