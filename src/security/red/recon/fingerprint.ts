/**
 * Extended technology fingerprinting (Supremacy M3.2): JS framework versions,
 * server headers, CDN detection, well-known files. Feeds mapKnownVulns with
 * richer signals than the base reconTarget.
 */

export interface TechFingerprint {
  name: string;
  version?: string;
  source: "header" | "body" | "wellknown" | "cookie";
  evidence: string;
}

/** Extract framework/library versions from HTML + JS bundle markers. */
export function fingerprintFromHtml(html: string): TechFingerprint[] {
  const out: TechFingerprint[] = [];
  const add = (name: string, version: string | undefined, evidence: string): void => {
    out.push({ name, ...(version ? { version } : {}), source: "body", evidence: evidence.slice(0, 200) });
  };
  const reactVer = /react[.-]?v(?:ersion)?[=:"' ]+([\d.]+)/i.exec(html) ?? /data-reactroot.*react[ ("']([\d.]+)/i.exec(html);
  if (reactVer) add("react", reactVer[1], "React version marker in HTML");
  const vueVer = /vue[.-]?v(?:ersion)?[=:"' ]+([\d.]+)/i.exec(html);
  if (vueVer) add("vue", vueVer[1], "Vue version marker");
  const angularVer = /ng-version="([\d.]+)"/i.exec(html);
  if (angularVer) add("angular", angularVer[1], "ng-version attribute");
  const nextVer = /__NEXT_DATA__.*"version":"([\d.]+)"/.exec(html);
  if (nextVer) add("nextjs", nextVer[1], "__NEXT_DATA__ version");
  if (/_next\//.test(html)) out.push({ name: "nextjs", source: "body", evidence: "_next/ asset path" });
  if (/wp-content\//.test(html)) out.push({ name: "wordpress", source: "body", evidence: "wp-content/ path" });
  if (/\/drupal\//.test(html)) out.push({ name: "drupal", source: "body", evidence: "drupal path" });
  if (/cdn\.jsdelivr\.net/.test(html)) out.push({ name: "jsdelivr", source: "body", evidence: "jsdelivr CDN reference" });
  if (/unpkg\.com/.test(html)) out.push({ name: "unpkg", source: "body", evidence: "unpkg CDN reference" });
  if (/bootstrap(?:\.min)?\.(?:css|js)/i.test(html)) out.push({ name: "bootstrap", source: "body", evidence: "Bootstrap asset" });
  return out;
}

/** Extract from response headers. */
export function fingerprintFromHeaders(headers: Record<string, string>): TechFingerprint[] {
  const out: TechFingerprint[] = [];
  const server = headers["server"];
  if (server) {
    const [name, version] = server.split("/");
    out.push({ name: name!.toLowerCase(), ...(version ? { version } : {}), source: "header", evidence: `Server: ${server}` });
  }
  const poweredBy = headers["x-powered-by"];
  if (poweredBy) {
    const [name, version] = poweredBy.split("/");
    out.push({ name: name!.toLowerCase(), ...(version ? { version } : {}), source: "header", evidence: `X-Powered-By: ${poweredBy}` });
  }
  const cdn = headers["x-cdn"] ?? headers["cf-ray"] ? "cloudflare" : headers["x-vercel-id"] ? "vercel" : undefined;
  if (cdn) out.push({ name: cdn, source: "header", evidence: `CDN header detected` });
  if (headers["x-aspnet-version"]) out.push({ name: "asp.net", version: headers["x-aspnet-version"], source: "header", evidence: `X-AspNet-Version: ${headers["x-aspnet-version"]}` });
  if (headers["x-generator"]?.includes("Drupal")) out.push({ name: "drupal", source: "header", evidence: `X-Generator: ${headers["x-generator"]}` });
  return out;
}

/** Well-known files that reveal tech. */
export function fingerprintFromWellKnown(path: string, body: string): TechFingerprint[] {
  const out: TechFingerprint[] = [];
  if (path === "/.well-known/security.txt" && body.length > 0) {
    out.push({ name: "securitytxt", source: "wellknown", evidence: "security.txt present" });
  }
  if (path === "/.well-known/openid-configuration" && body.includes("issuer")) {
    out.push({ name: "openid", source: "wellknown", evidence: "OpenID configuration present" });
  }
  return out;
}
