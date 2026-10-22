import {planOpenApi} from './openapi.js';
import type { PentestFinding } from "../tools/pentest.js";
import { inScope, type CampaignScope, type HttpResult } from "./scope.js";

export interface DiscoveredPage { url: string; depth: number; source: "seed" | "link" | "openapi"; status?: number; contentType?: string; forms?: number }
export interface DiscoveryResult { pages: DiscoveredPage[]; skipped: number; truncated: boolean; limits?:{depth:number;pages:number;queue:number}; unvisited?:Array<{url:string;reason:'depth'|'pages'|'queue'}> }
export function apiPaths(input:unknown,scope:CampaignScope,fixtures?:unknown):string[]{return planOpenApi(input,scope,fixtures)?.seeds??[];}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return result;
}
export function inspectPage(url: string, response: HttpResult): PentestFinding[] {
  if (!response.ok) return [];
  const findings: PentestFinding[] = [];
  const add = (check: string, severity: PentestFinding["severity"], title: string, detail: string, remediation: string) => findings.push({ id: `${check}-${findings.length+1}`, check, severity, verdict: "finding", target: url, title, detail, remediation });
  const csp = response.headers["content-security-policy"] ?? "";
  if (/'unsafe-eval'|'unsafe-inline'/.test(csp)) add("weak_csp", "low", "CSP permits inline or dynamically evaluated scripts", "Observed unsafe-inline or unsafe-eval in Content-Security-Policy; effective protection depends on directive and nonce handling.", "Review script-src; use nonces/hashes and remove unnecessary unsafe directives.");
  if (/Traceback \(most recent call last\)|Fatal error:.*on line \d|(?:SQLSTATE\[|Exception in thread)/.test(response.body)) add("error_disclosure", "medium", "Diagnostic error signature in response", "Response contains a stack-trace or database-error signature. Raw response is not retained.", "Return generic errors to clients and retain diagnostic details in server logs.");
  const isHtml = (response.headers["content-type"] ?? "").includes("text/html") || /<!doctype html|<html[\s>]/i.test(response.body);
  if (!isHtml) return findings;
  if (url.startsWith("https:") && /<(?:script|iframe|link|img)\b[^>]*(?:src|href)\s*=\s*["']http:\/\//i.test(response.body)) add("mixed_content", "medium", "HTTPS page references unencrypted resources", "An HTML resource reference uses http://. Browser behavior varies by resource type.", "Serve all page resources over HTTPS.");
  const forms = [...response.body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  for (const [index, form] of forms.entries()) {
    const attrs = attributes(form[1]!); const body = form[2]!;
    if (/type\s*=\s*["']?password/i.test(body)) {
      let action: URL; try { action = new URL(attrs.action || url, url); } catch { continue; }
      if (action.protocol === "http:" || (attrs.method ?? "get").toLowerCase() === "get") add("credential_form", "high", "Password form uses GET or unencrypted transport", `Form ${index+1}: method=${(attrs.method ?? "GET").toUpperCase()}, transport=${action.protocol}. No form was submitted.`, "Submit credentials with POST over HTTPS; avoid credentials in URLs.");
    }
    if ((attrs.method ?? "get").toLowerCase() === "post" && !/(?:csrf|xsrf|authenticity)[_-]?(?:token)?/i.test(body)) {
      findings.push({ id: `csrf_review-${index+1}`, check: "csrf_review", severity: "info", verdict: "info", target: url, title: "Review CSRF protection on POST form", detail: `Form ${index+1} has no recognizable anti-CSRF field. SameSite cookies, origin validation or framework controls may provide protection. No submission was attempted.`, remediation: "Verify server-side anti-CSRF controls; absence of a hidden field alone is not a confirmed vulnerability." });
    }
  }
  return findings;
}
export async function discover(scope: CampaignScope, request: (url: string) => Promise<HttpResult>, apiSeeds: string[], signal: AbortSignal, visit: (page: DiscoveredPage, response: HttpResult) => void): Promise<DiscoveryResult> {
  const queue: DiscoveredPage[] = [...scope.seeds.map(url=>({url,depth:0,source:"seed" as const})), ...apiSeeds.map(url=>({url,depth:0,source:"openapi" as const}))];
  const seen = new Set<string>(), pages: DiscoveredPage[] = []; let skipped = 0;
  const queued=new Set(queue.map(p=>p.url)),deferred=new Map<string,'depth'|'queue'>();
  while (queue.length && pages.length < scope.maxPages) {
    signal.throwIfAborted();
    const page = queue.shift()!;queued.delete(page.url); if (seen.has(page.url)) continue; seen.add(page.url);
    if (!inScope(scope, page.url)) { skipped++; continue; }
    const response = await request(page.url);
    page.status=response.status;page.contentType=response.headers["content-type"]?.split(";")[0];
    page.forms=[...response.body.matchAll(/<form\b/gi)].length;
    pages.push(page);visit(page,response);
    if (!response.ok) continue;
    for (const match of response.body.matchAll(/<a\b[^>]*>/gi)) {
      const href = attributes(match[0]).href; if (!href) continue;
      let url: URL; try { url=new URL(href.replace(/&amp;/g,"&"), page.url);url.hash=""; } catch { skipped++;continue; }
      if (!inScope(scope,url.href)) { skipped++;continue; }
      if(seen.has(url.href)||queued.has(url.href))continue;
      if(page.depth>=scope.maxDepth){deferred.set(url.href,'depth');continue;}
      if(queue.length>=scope.maxPages*10){deferred.set(url.href,'queue');continue;}
      deferred.delete(url.href);queued.add(url.href);queue.push({url:url.href,depth:page.depth+1,source:"link"});
    }
  }
  const pending=new Map<string,'depth'|'pages'|'queue'>([...deferred].filter(([url])=>!seen.has(url)));
  for(const page of queue)if(!seen.has(page.url)&&inScope(scope,page.url))pending.set(page.url,'pages');
  const limits={depth:0,pages:0,queue:0};for(const reason of pending.values())limits[reason]++;
  return {pages,skipped,truncated:pending.size>0,limits,unvisited:[...pending].slice(0,100).map(([url,reason])=>({url,reason}))};
}
