/** Small string helpers used across the app. */

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function truncate(input: string, max: number): string {
  if (max <= 0) return "";
  return input.length <= max ? input : `${input.slice(0, Math.max(0, max - 1))}…`;
}

export function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
