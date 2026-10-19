export interface ExpectedResponse { method: string; path: string; status: number; count?: number }
export function validateExpectedResponses(value: unknown): asserts value is ExpectedResponse[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 12) throw new Error("expectedResponses must contain at most 12 declarations");
  const seen = new Set<string>();
  for (const r of value) {
    if (!r || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(r.method) || typeof r.path !== "string" || r.path.length > 1000 || !r.path.startsWith("/") || r.path.startsWith("//") || /[\\#\r\n]/.test(r.path) || !Number.isInteger(r.status) || r.status < 200 || r.status > 499 || !Number.isInteger(r.count ?? 1) || (r.count ?? 1) < 1 || (r.count ?? 1) > 10) throw new Error("Invalid expected HTTP response; require method, local path, status 200–499 and count 1–10");
    const key = JSON.stringify([r.method, r.path, r.status]);
    if (seen.has(key)) throw new Error("Duplicate expected response; use count instead");
    seen.add(key);
  }
}
export class HttpExpectations {
  readonly observed: Array<{ method: string; path: string; status: number }> = [];
  constructor(private readonly expected: ExpectedResponse[] = []) {}
  record(method: string, path: string, status: number): boolean {
    this.observed.push({ method, path, status });
    const match = this.expected.find(e => e.method === method && e.path === path && e.status === status);
    return !!match && this.matches(match) <= (match.count ?? 1);
  }
  private matches(e: ExpectedResponse): number { return this.observed.filter(r => r.method === e.method && r.path === e.path && r.status === e.status).length; }
  satisfied(): boolean { return this.expected.every(e => this.matches(e) === (e.count ?? 1)); }
  assertSatisfied(): void {
    for (const e of this.expected) if (this.matches(e) !== (e.count ?? 1)) throw new Error(`Expected ${e.count ?? 1} response(s) ${e.method} ${e.path} HTTP ${e.status}; observed ${this.matches(e)}`);
  }
  isExpectedResourceError(path: string, text: string): boolean {
    const status = text.match(/^Failed to load resource: the server responded with a status of (\d{3})\b/)?.[1];
    return !!status && this.expected.some(e => e.path === path && e.status === Number(status) && this.matches(e) > 0 && this.matches(e) <= (e.count ?? 1));
  }
}
