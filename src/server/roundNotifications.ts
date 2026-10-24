/**
 * Neo N8: Approval-gated outgoing notifications and emails for recurring rounds.
 *
 * Each round completion can emit an email notification to bound email channels,
 * strictly routed through the approval gate (src/server/approvals.ts) before
 * dispatch. The email is never sent without user approval (or approval rule).
 */
import { createApproval, waitForDecision } from "./approvals.js";
import { findBinding, getActiveChannelRouter, listBindings } from "./channels/router.js";
import type { EmailChannel } from "./channels/email.js";
import { log } from "../log.js";

export interface RoundEmailNotificationInput {
  taskId: string;
  round: number;
  scheduleId?: string;
  agentId?: string;
  summary: string;
  signal?: AbortSignal;
  /** When false, queues the approval record without blocking and returns status "pending". Default true. */
  wait?: boolean;
}

export interface RoundEmailNotificationResult {
  sent: boolean;
  approvalId?: string;
  status: "approved" | "denied" | "expired" | "pending" | "no_binding" | "no_channel";
  recipient?: string;
}

/**
 * Request approval to send a round completion notification email, and deliver it
 * via the active EmailChannel if approved.
 */
export async function sendRoundEmailWithApproval(
  input: RoundEmailNotificationInput,
): Promise<RoundEmailNotificationResult> {
  const router = getActiveChannelRouter();
  if (!router) {
    return { sent: false, status: "no_channel" };
  }

  const emailChannel = router.channels.find((c) => c.name === "email") as EmailChannel | undefined;
  if (!emailChannel || !emailChannel.configured) {
    return { sent: false, status: "no_channel" };
  }

  // Find recipient: check bindings for this agent or general email bindings
  let recipient = "";
  if (input.agentId) {
    const bindings = listBindings(input.agentId).filter((b) => b.channel === "email");
    if (bindings.length > 0) {
      recipient = bindings[0]!.chatId;
    }
  }

  if (!recipient) {
    const allEmailBindings = listBindings().filter((b) => b.channel === "email");
    if (allEmailBindings.length > 0) {
      recipient = allEmailBindings[0]!.chatId;
    }
  }

  if (!recipient) {
    return { sent: false, status: "no_binding" };
  }

  const subject = `Mission Round ${input.round} Completed (${input.taskId})`;
  const emailBody = `Round ${input.round} of mission ${input.taskId} has completed.${input.scheduleId ? ` (Schedule: ${input.scheduleId})` : ""}\n\nSummary:\n${input.summary}`;

  // Gate through approvals
  const approval = createApproval({
    taskId: input.taskId,
    tool: "round_email_notification",
    summary: `Send round ${input.round} completion email to ${recipient}`,
    argsPreview: JSON.stringify({ recipient, subject, preview: input.summary.slice(0, 200) }),
  });

  const deliverWhenApproved = async (): Promise<RoundEmailNotificationResult> => {
    const decision = await waitForDecision(approval.id, input.signal);
    if (decision !== "approved") {
      log.info(`round email for task ${input.taskId} round ${input.round} was ${decision}`);
      return { sent: false, approvalId: approval.id, status: decision, recipient };
    }

    try {
      await emailChannel.send(recipient, `${subject}\n\n${emailBody}`);
      log.info(`round email for task ${input.taskId} round ${input.round} sent to ${recipient}`);
      return { sent: true, approvalId: approval.id, status: "approved", recipient };
    } catch (err) {
      log.warn(`failed to send round email: ${String(err)}`);
      return { sent: false, approvalId: approval.id, status: "approved", recipient };
    }
  };

  if (input.wait === false) {
    return { sent: false, approvalId: approval.id, status: "pending", recipient };
  }

  return deliverWhenApproved();
}
