const TRUSTED_EXTERNAL_SCHEMES = new Set(["https:", "mailto:"]);
const TRUSTED_EXTERNAL_HOSTS = new Set(["localhost:8787", "127.0.0.1:8787", "localhost:8788", "127.0.0.1:8788"]);

function isTrustedExternalUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && TRUSTED_EXTERNAL_HOSTS.has(u.host)) return true;
    return TRUSTED_EXTERNAL_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

module.exports = { isTrustedExternalUrl };
