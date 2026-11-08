/**
 * D14 — automation event triggers.
 *
 * Pure, store-free helpers for the two event triggers an automation can carry:
 * a generic HMAC-verified webhook and GitHub events delivered through the same
 * webhook transport. Cron triggers need no helpers here; the existing scheduler
 * already fires them from `nextRunAt`.
 *
 * Everything in this module is side-effect free so the signature checks, the
 * GitHub payload mapping and the prompt assembly stay unit-testable without a
 * server, a store or a network.
 */
import crypto from "node:crypto";
import type { AutomationTrigger, Schedule } from "./db.js";

/** GitHub events this build knows how to turn into a prompt. */
export const GITHUB_ISSUE_EVENTS = ["issues.opened", "issues.labeled"] as const;
export const GITHUB_PR_COMMENT_EVENT = "issue_comment.created";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Effective trigger for a stored automation (defaults to cron). */
export function automationTriggerOf(s: Pick<Schedule, "trigger" | "webhookSecret" | "githubEvents">): AutomationTrigger {
  if (s.trigger) return s.trigger;
  if (s.githubEvents?.length) return "github";
  if (s.webhookSecret) return "webhook";
  return "cron";
}

/**
 * Verify an HMAC signature over the RAW request body. Accepts a bare hex digest
 * or the common `sha256=<hex>` header form. Comparison is length-guarded and
 * constant-time; a missing secret or signature never verifies.
 */
export function verifyHmacSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string | undefined,
  algorithm = "sha256",
): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac(algorithm, secret).update(rawBody).digest("hex");
  const supplied = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return supplied.length === computed.length && crypto.timingSafeEqual(supplied, computed);
}

/** Extract the hex digest from a `sha256=...` signature header (or a bare digest). */
export function parseSignatureHeader(header: string | undefined, algorithm = "sha256"): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const prefix = `${algorithm}=`;
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

/** Combine a GitHub `x-github-event` header with the payload action into `event.action`. */
export function githubEventName(event: string | undefined, action: string | undefined): string | undefined {
  const ev = event?.trim().toLowerCase();
  if (!ev) return undefined;
  const act = action?.trim().toLowerCase();
  return act ? `${ev}.${act}` : ev;
}

/** True when `event` is covered by the automation's allow-list (`*` matches all). */
export function githubEventMatches(allowed: string[] | undefined, event: string): boolean {
  if (!allowed || allowed.length === 0) return false;
  return allowed.some((a) => a === event || a === "*" || (a.endsWith(".*") && event.startsWith(a.slice(0, -1))));
}

/**
 * Map a supported GitHub event payload to a session prompt. Returns undefined
 * for events this build does not handle (e.g. a comment on a plain issue) so
 * the caller can ignore the delivery instead of starting an off-topic run.
 */
export function githubPayloadToPrompt(event: string, body: unknown, _fallback: string): string | undefined {
  const b = asRecord(body) ?? {};
  const repo = str(asRecord(b.repository)?.full_name) || "unknown/repo";
  if (event === "issues.opened") {
    const issue = asRecord(b.issue) ?? {};
    const number = issue.number;
    const title = str(issue.title);
    const text = str(issue.body);
    return `[GitHub] New issue #${number} in ${repo}: ${title}${text ? `\n\n${text}` : ""}`;
  }
  if (event === "issues.labeled") {
    const issue = asRecord(b.issue) ?? {};
    const number = issue.number;
    const title = str(issue.title);
    const label = str(asRecord(b.label)?.name);
    return `[GitHub] Issue #${number} in ${repo} labeled "${label}": ${title}`;
  }
  if (event === GITHUB_PR_COMMENT_EVENT) {
    const issue = asRecord(b.issue) ?? {};
    // GitHub delivers PR comments as issue_comment; only those are triggers.
    if (!issue.pull_request) return undefined;
    const number = issue.number;
    const title = str(issue.title);
    const comment = str(asRecord(b.comment)?.body);
    return `[GitHub] New comment on PR #${number} in ${repo}: ${title}${comment ? `\n\n${comment}` : ""}`;
  }
  return undefined;
}

/**
 * Assemble the prompt a triggered run should execute. GitHub events use their
 * mapped prompt; webhooks may carry their own `prompt`/`message`; everything
 * else falls back to the stored automation prompt.
 */
export function buildAutomationPrompt(schedule: Schedule, payload?: unknown, githubEvent?: string): string {
  const trigger = automationTriggerOf(schedule);
  // The playbook is the automation's instruction; prompt is the fallback.
  const base = schedule.playbook?.trim() || schedule.prompt;
  if (trigger === "github") {
    const mapped = githubEvent ? githubPayloadToPrompt(githubEvent, payload, base) : undefined;
    if (mapped) return mapped;
  }
  if (trigger === "webhook") {
    const rec = asRecord(payload);
    const override = rec ? str(rec.prompt) || str(rec.message) : "";
    if (override) return override;
  }
  return automationPayloadToPrompt(trigger, payload) ?? base;
}

export function automationEventMatches(trigger: AutomationTrigger, allowed: string[] | undefined, eventKind: string): boolean {
  if (trigger === "webhook" || trigger === "cron") return true;
  return githubEventMatches(allowed, eventKind) || allowed?.includes("*") === true;
}

export function automationEventKind(trigger: AutomationTrigger, payload: unknown, githubEvent?: string): string {
  if (trigger === "github") return githubEvent ?? "unknown";
  const body = asRecord(payload) ?? {};
  if (trigger === "slack") return str(asRecord(body.event)?.type) || str(body.type) || "message";
  if (trigger === "microsoftTeams") return str(body.type) || "message";
  if (trigger === "linear") return str(body.action) || str(body.type) || "issue";
  if (trigger === "sentry") return str(body.action) || "event";
  if (trigger === "pagerduty") return str(body.event) || "incident";
  if (trigger === "email") return "email.received";
  return "webhook";
}

export function automationPayloadToPrompt(trigger: AutomationTrigger, payload: unknown): string | undefined {
  const body = asRecord(payload) ?? {};
  if (trigger === "slack") {
    const event = asRecord(body.event) ?? body;
    const text = str(event.text) || str(body.text);
    const channel = str(event.channel) || str(body.channel) || "unknown";
    return `[Slack] ${automationEventKind(trigger, payload)} in ${channel}: ${text || "event received"}`;
  }
  if (trigger === "microsoftTeams") {
    const text = str(body.text) || str(asRecord(body.message)?.text) || str(body.summary);
    const from = str(asRecord(body.from)?.name) || str(asRecord(body.sender)?.name) || "Microsoft Teams";
    return `[Microsoft Teams] ${from}: ${text || "event received"}`;
  }
  if (trigger === "linear") {
    const data = asRecord(body.data) ?? body;
    const title = str(data.title) || str(data.identifier) || "Linear event";
    const description = str(data.description) || str(data.url);
    return `[Linear] ${title}${description ? `\n\n${description}` : ""}`;
  }
  if (trigger === "sentry") {
    const event = asRecord(body.event) ?? body;
    const title = str(event.title) || str(event.message) || "Sentry event";
    const level = str(event.level);
    const url = str(event.url) || str(body.url);
    return `[Sentry] ${level ? `${level}: ` : ""}${title}${url ? `\n\n${url}` : ""}`;
  }
  if (trigger === "pagerduty") {
    const data = asRecord(body.data) ?? body;
    const title = str(data.title) || str(data.summary) || "PagerDuty incident";
    const status = str(data.status);
    const url = str(data.html_url);
    return `[PagerDuty] ${status ? `${status}: ` : ""}${title}${url ? `\n\n${url}` : ""}`;
  }
  if (trigger === "email") {
    const from = str(body.from) || str(body.sender) || "unknown sender";
    const subject = str(body.subject) || "(no subject)";
    const text = str(body.text) || str(body.body);
    return `[Email] ${from} — ${subject}${text ? `\n\n${text}` : ""}`;
  }
  return undefined;
}

export function verifySlackRequest(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string | undefined): boolean {
  if (!timestamp || !signature || !secret || !/^\d+$/.test(timestamp)) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (ageSeconds > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody.toString("utf8")}`).digest("hex");
  const supplied = Buffer.from(signature.replace(/^v0=/, ""), "utf8");
  const computed = Buffer.from(expected, "utf8");
  return supplied.length === computed.length && crypto.timingSafeEqual(supplied, computed);
}
