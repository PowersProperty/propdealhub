// ════════════════════════════════════════════════════════════════════════════
// Outreach Sequencer — tiered auto-send + review queue
// ────────────────────────────────────────────────────────────────────────────
// Tiers:
//   dealScore >= 9.0  → auto-send (queued with tier='auto', status='approved')
//   7.5 ≤ score < 9.0 → review queue (tier='review', status='pending')
//   score < 7.5        → skipped
//
// Cadence (per lead, until reply/unsubscribe/deal stage change):
//   step 1 → send immediately on qualification
//   step 2 → +3 days  if no reply
//   (step 3 → +7 days  future)
//
// Runs via cron-job.org every 15 minutes. Also exposed as /api/outreach/tick.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from "./db";
import { leads, outreachLog, outreachQueue } from "../drizzle/schema";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { pickTemplate, renderEmail, TemplateId } from "./templates";
import {
  checkSendAllowed,
  generateUnsubscribeToken,
  buildUnsubscribeUrl,
} from "./compliance";
import { sendEmail } from "./gmail-sender";

const AUTO_SEND_THRESHOLD = 9.0;
const REVIEW_THRESHOLD = 7.5;

const STEP_DELAYS_DAYS = [0, 3]; // step 1 immediate, step 2 at +3d

// Pipeline stages where outreach should pause (we're talking to them)
const ACTIVE_STAGES = [
  "conversation_started",
  "appointment_scheduled",
  "property_visit",
  "offer_sent",
  "under_contract",
  "closed",
  "dead",
];

// ────────────────────────────────────────────────────────────────────────────
// qualifyLead — given a lead, decide which queue items to create
// ────────────────────────────────────────────────────────────────────────────

export async function qualifyLead(leadId: number): Promise<{
  queued: number;
  skipped: string[];
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const skipped: string[] = [];

  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return { queued: 0, skipped: ["lead_not_found"] };

  // Score gate
  const score = lead.dealScore ?? 0;
  if (score < REVIEW_THRESHOLD) {
    skipped.push(`below_threshold:${score}`);
    return { queued: 0, skipped };
  }

  // Stage gate
  if (ACTIVE_STAGES.includes(lead.pipelineStage as any)) {
    skipped.push(`stage:${lead.pipelineStage}`);
    return { queued: 0, skipped };
  }

  // Must have email for Phase 2 (SMS is later)
  if (!lead.ownerEmail) {
    skipped.push("no_email");
    return { queued: 0, skipped };
  }

  const tier: "auto" | "review" = score >= AUTO_SEND_THRESHOLD ? "auto" : "review";

  // Don't re-queue if we already have a pending/approved item for this lead
  const existing = await db
    .select({ id: outreachQueue.id })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.leadId, leadId),
        inArray(outreachQueue.status, ["pending", "approved"])
      )
    )
    .limit(1);
  if (existing.length > 0) {
    skipped.push("already_queued");
    return { queued: 0, skipped };
  }

  // Figure out which step we're on (based on prior sends)
  const sends = await db
    .select()
    .from(outreachLog)
    .where(
      and(
        eq(outreachLog.leadId, leadId),
        eq(outreachLog.channel, "email"),
        eq(outreachLog.direction, "outbound")
      )
    );
  const step = sends.length + 1;
  if (step > STEP_DELAYS_DAYS.length) {
    skipped.push("sequence_complete");
    return { queued: 0, skipped };
  }

  // Gate the send against compliance
  const gate = await checkSendAllowed({
    channel: "email",
    contact: lead.ownerEmail,
    subject: "placeholder",
  });
  if (!gate.allowed) {
    skipped.push(`compliance:${gate.reason}`);
    return { queued: 0, skipped };
  }

  // Render
  const templateId: TemplateId = pickTemplate(lead.leadType, step);
  const unsubToken = generateUnsubscribeToken();
  const rendered = renderEmail(lead as any, templateId, unsubToken);

  const scheduledFor = new Date(
    Date.now() + STEP_DELAYS_DAYS[step - 1] * 24 * 60 * 60 * 1000
  );

  await db.insert(outreachQueue).values({
    leadId,
    channel: "email",
    templateId,
    subject: rendered.subject,
    renderedBody: rendered.textBody,
    tier,
    status: tier === "auto" ? "approved" : "pending",
    scheduledFor,
    unsubscribeToken: unsubToken,
  });

  return { queued: 1, skipped };
}

// ────────────────────────────────────────────────────────────────────────────
// qualifyAll — sweep every eligible lead and queue outreach
// Useful for: initial backfill, or running after a big BatchData pull.
// ────────────────────────────────────────────────────────────────────────────

export async function qualifyAll(): Promise<{
  processed: number;
  queued: number;
  skipped: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Leads above review threshold that aren't in an active stage
  const candidates = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        gte(leads.dealScore, REVIEW_THRESHOLD),
        // pipelineStage NOT in active stages
        sql`${leads.pipelineStage} NOT IN ('conversation_started','appointment_scheduled','property_visit','offer_sent','under_contract','closed','dead')`
      )
    );

  let queued = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      const r = await qualifyLead(c.id);
      queued += r.queued;
      if (r.queued === 0) skipped++;
    } catch {
      skipped++;
    }
  }
  return { processed: candidates.length, queued, skipped };
}

// ────────────────────────────────────────────────────────────────────────────
// tick — called by cron. Sends everything due.
//
//   1. Find queue items with status='approved' and scheduled_for <= NOW
//   2. Re-check suppression list (things can change)
//   3. Send via Gmail
//   4. Record in outreach_log
//   5. Mark queue row 'sent' or 'failed'
// ────────────────────────────────────────────────────────────────────────────

export async function tick(limit: number = 50): Promise<{
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const due = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.status, "approved"),
        or(isNull(outreachQueue.scheduledFor), lte(outreachQueue.scheduledFor, new Date()))
      )
    )
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of due as any[]) {
    try {
      // Reload lead to get current email
      const [lead] = await db.select().from(leads).where(eq(leads.id, item.leadId)).limit(1);
      if (!lead || !lead.ownerEmail) {
        await db
          .update(outreachQueue)
          .set({
            status: "failed",
            failureReason: "Lead missing or no email",
          })
          .where(eq(outreachQueue.id, item.id));
        failed++;
        continue;
      }

      // Re-gate (suppression may have changed)
      const gate = await checkSendAllowed({
        channel: "email",
        contact: lead.ownerEmail,
        subject: item.subject ?? undefined,
      });
      if (!gate.allowed) {
        await db
          .update(outreachQueue)
          .set({
            status: "skipped_suppressed",
            failureReason: gate.reason,
          })
          .where(eq(outreachQueue.id, item.id));
        skipped++;
        continue;
      }

      // Re-render with current values (templates have live personalization)
      const rendered = renderEmail(
        lead as any,
        item.templateId as TemplateId,
        item.unsubscribeToken
      );

      const sendResult = await sendEmail({
        to: lead.ownerEmail,
        subject: rendered.subject,
        textBody: rendered.textBody,
        htmlBody: rendered.htmlBody,
        unsubscribeUrl: buildUnsubscribeUrl(item.unsubscribeToken),
        fromName: "Chris Powers",
      });

      // Log the send
      await db.insert(outreachLog).values({
        leadId: lead.id,
        channel: "email",
        direction: "outbound",
        message: rendered.textBody,
        status: "sent",
        templateId: item.templateId,
        unsubscribeToken: item.unsubscribeToken,
        gmailMessageId: sendResult.messageId,
        subject: rendered.subject,
        sentAt: new Date(),
      } as any);

      await db
        .update(outreachQueue)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(outreachQueue.id, item.id));

      // Advance pipeline to "contacted" if still new_lead
      if (lead.pipelineStage === "new_lead") {
        await db
          .update(leads)
          .set({ pipelineStage: "contacted" })
          .where(eq(leads.id, lead.id));
      }

      sent++;
    } catch (e: any) {
      await db
        .update(outreachQueue)
        .set({
          status: "failed",
          failureReason: String(e?.message ?? e).slice(0, 500),
        })
        .where(eq(outreachQueue.id, item.id));
      failed++;
    }
  }

  return { attempted: due.length, sent, failed, skipped };
}

// ────────────────────────────────────────────────────────────────────────────
// Review queue operations
// ────────────────────────────────────────────────────────────────────────────

export async function listReviewQueue(limit: number = 50) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const rows = await db
    .select({
      queueId: outreachQueue.id,
      leadId: outreachQueue.leadId,
      templateId: outreachQueue.templateId,
      subject: outreachQueue.subject,
      renderedBody: outreachQueue.renderedBody,
      scheduledFor: outreachQueue.scheduledFor,
      createdAt: outreachQueue.createdAt,
      address: leads.address,
      city: leads.city,
      state: leads.state,
      zip: leads.zip,
      ownerName: leads.ownerName,
      ownerEmail: leads.ownerEmail,
      leadType: leads.leadType,
      dealScore: leads.dealScore,
      equity: leads.equity,
    })
    .from(outreachQueue)
    .innerJoin(leads, eq(leads.id, outreachQueue.leadId))
    .where(and(eq(outreachQueue.status, "pending"), eq(outreachQueue.tier, "review")))
    .limit(limit);

  return rows;
}

export async function approveQueueItem(queueId: number, reviewer: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(outreachQueue)
    .set({
      status: "approved",
      reviewedBy: reviewer,
      reviewedAt: new Date(),
    })
    .where(eq(outreachQueue.id, queueId));
}

export async function rejectQueueItem(
  queueId: number,
  reviewer: string,
  reason?: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(outreachQueue)
    .set({
      status: "rejected",
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      failureReason: reason ?? null,
    })
    .where(eq(outreachQueue.id, queueId));
}

export async function editQueueItem(
  queueId: number,
  updates: { subject?: string; renderedBody?: string }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(outreachQueue)
    .set({
      subject: updates.subject,
      renderedBody: updates.renderedBody ?? undefined,
    })
    .where(eq(outreachQueue.id, queueId));
}
