/**
 * Minimal ambient declaration for js-yaml (present in the dependency tree as a
 * transitive dependency). The env-blueprint file (`loam.env.yaml`) is parsed and
 * written through this module only, so the surface we need is tiny.
 */
declare module "js-yaml" {
  export function load(input: string, opts?: Record<string, unknown>): unknown;
  export function dump(input: unknown, opts?: Record<string, unknown>): string;
  export function safeLoad(input: string): unknown;
  export function safeDump(input: unknown): string;
}
