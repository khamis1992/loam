export function shortUid(): string {
  const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const b = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(b, (x) => a[x % 62]).join('');
}
