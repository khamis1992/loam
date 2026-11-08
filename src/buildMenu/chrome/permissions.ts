import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const supported = new Set(['activeTab', 'scripting', 'storage']);

export function assertMinimalPermissions(permissions: readonly string[], hosts: readonly string[]): void {
  if (permissions.some((permission) => urlPattern(permission) || !supported.has(permission))) throw new Error('permission_requires_review');
  if (hosts.length !== 0) throw new Error('host_requires_review');
}

export function assertExtensionManifest(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('permission_requires_review');
  const manifest = value as Record<string, unknown>;
  const permissions = [
    ...stringList(manifest.permissions, 'permission_requires_review'),
    ...stringList(manifest.optional_permissions, 'permission_requires_review'),
  ];
  const optionalHosts = stringList(manifest.optional_host_permissions, 'host_requires_review');
  if (optionalHosts.length !== 0 || optionalHosts.some(isRemoteMatch)) throw new Error('host_requires_review');
  const hosts = [
    ...stringList(manifest.host_permissions, 'host_requires_review'),
    ...contentHosts(manifest.content_scripts),
  ];
  assertMinimalPermissions(permissions, hosts);
  assertPrivilegedSurface(manifest);
  assertExtensionCsp(manifest.content_security_policy);
  if (manifest.externally_connectable !== undefined) throw new Error('permission_requires_review');
  assertNoHiddenHost(manifest);
}

export function extensionPermissionDigest(value: unknown): string {
  assertExtensionManifest(value);
  const manifest = value as Record<string, unknown>;
  const surface = {
    permissions: [...stringList(manifest.permissions, 'permission_requires_review')].sort(),
    optional_permissions: [...stringList(manifest.optional_permissions, 'permission_requires_review')].sort(),
    host_permissions: [...stringList(manifest.host_permissions, 'host_requires_review')].sort(),
    optional_host_permissions: [...stringList(manifest.optional_host_permissions, 'host_requires_review')].sort(),
    content_scripts: digestContentScripts(manifest.content_scripts),
    content_security_policy: manifest.content_security_policy ?? null,
    externally_connectable: manifest.externally_connectable ?? null,
  };
  return createHash('sha256').update(JSON.stringify(surface)).digest('hex');
}

export function recordApprovedExtension(workspace: string): string {
  const manifestPath = path.join(workspace, 'app', 'manifest.json');
  assertExclusiveRead(manifestPath);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  const sha256 = extensionPermissionDigest(parsed);
  const dir = path.join(workspace, '.loam', 'build-menu');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'approved-extension.json');
  assertExclusiveNote(target);
  fs.writeFileSync(target, `${JSON.stringify({ sha256 })}\n`);
  return sha256;
}

function assertExclusiveNote(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
}

function nodeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function assertExclusiveRead(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
}

export function approvedExtensionDigest(workspace: string): string | null {
  const target = path.join(workspace, '.loam', 'build-menu', 'approved-extension.json');
  if (!fs.existsSync(target)) return null;
  assertExclusiveRead(target);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { sha256?: unknown };
  return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
}

function stringList(value: unknown, error: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(error);
  return value;
}

const PAGE_CSP = "script-src 'self'; object-src 'self'";
const PRIVILEGED = ['background', 'devtools_page', 'chrome_url_overrides', 'sandbox', 'declarative_net_request', 'declarative_net_request_with_host_access'] as const;

function assertExtensionCsp(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('permission_requires_review');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'extension_pages' || record.extension_pages !== PAGE_CSP) {
    throw new Error('permission_requires_review');
  }
}

function assertPrivilegedSurface(manifest: Record<string, unknown>): void {
  for (const key of PRIVILEGED) {
    if (manifest[key] !== undefined) throw new Error('permission_requires_review');
  }
  assertScriptNames(manifest.content_scripts);
  assertContentScriptInjection(manifest.content_scripts);
  assertWebAccessible(manifest.web_accessible_resources);
}

function assertScriptNames(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('host_requires_review');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('host_requires_review');
    const record = item as { js?: unknown; css?: unknown };
    for (const field of [record.js, record.css]) {
      if (field === undefined) continue;
      if (!Array.isArray(field) || field.some((name) => !localFile(name))) throw new Error('permission_requires_review');
    }
  }
}

function assertContentScriptInjection(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.world !== undefined && record.world !== 'ISOLATED') throw new Error('permission_requires_review');
    if (record.match_about_blank !== undefined && record.match_about_blank !== false) throw new Error('permission_requires_review');
    if (record.match_origin_as_fallback !== undefined && record.match_origin_as_fallback !== false) throw new Error('permission_requires_review');
    assertContentScriptMatches(record.matches);
  }
}

function assertContentScriptMatches(value: unknown): void {
  if (value === undefined) return;
  const patterns = stringList(value, 'host_requires_review');
  if (patterns.some((pattern) => !localExtensionPage(pattern) || isRemoteMatch(pattern))) {
    throw new Error('host_requires_review');
  }
}

function assertWebAccessible(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('host_requires_review');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('host_requires_review');
    const record = item as { matches?: unknown; resources?: unknown; extension_ids?: unknown };
    const matches = stringList(record.matches ?? [], 'host_requires_review');
    if (matches.some((pattern) => !localExtensionPage(pattern) || isRemoteMatch(pattern) || pattern.includes('<all_urls>'))) {
      throw new Error('host_requires_review');
    }
    if (stringList(record.extension_ids ?? [], 'host_requires_review').length !== 0) throw new Error('host_requires_review');
    if (record.resources !== undefined && (!Array.isArray(record.resources) || record.resources.some((name) => !localFile(name)))) {
      throw new Error('permission_requires_review');
    }
  }
}

function localFile(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value);
}

function localExtensionPage(value: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.html$/.test(value);
}

function urlPattern(value: string): boolean {
  return value.includes('://') || value.includes('*') || value.includes('<') || value.includes('>');
}

function isRemoteMatch(value: string): boolean {
  return value.includes('<all_urls>') || value.includes('://') || value.startsWith('//') || value.includes('*');
}

function digestContentScripts(value: unknown): unknown {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.matches)) return item;
    return { ...record, matches: [...record.matches].sort() };
  });
}

const PATTERN_FIELDS = ['matches', 'exclude_matches', 'include_globs', 'exclude_globs'] as const;
const HOST_SURFACE = new Set(['update_url', 'chrome_settings_overrides', 'protocol_handlers']);

function contentHosts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('host_requires_review');
  const hosts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('host_requires_review');
    const record = item as Record<string, unknown>;
    for (const field of PATTERN_FIELDS) {
      if (record[field] === undefined) continue;
      for (const pattern of stringList(record[field], 'host_requires_review')) {
        if (!localExtensionPage(pattern)) hosts.push(pattern);
      }
    }
  }
  return hosts;
}

function assertNoHiddenHost(value: unknown): void {
  if (typeof value === 'string') {
    if (value === '*' || value.includes('<all_urls>') || value.includes('://')) throw new Error('host_requires_review');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoHiddenHost(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (HOST_SURFACE.has(key)) throw new Error('host_requires_review');
    assertNoHiddenHost(item);
  }
}
