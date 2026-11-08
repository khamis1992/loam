export interface PreviewFrame {
  src: string;
  sandbox: 'allow-scripts allow-same-origin';
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function previewFrame(url: string, pageOrigin: string): PreviewFrame | null {
  let parsed: URL;
  let page: URL;
  try {
    parsed = new URL(url);
    page = new URL(pageOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!loopback(parsed.hostname) || parsed.port === '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search.toLowerCase().includes('token=')) return null;
  if (parsed.origin === page.origin) return null;
  return { src: parsed.href, sandbox: 'allow-scripts allow-same-origin' };
}
