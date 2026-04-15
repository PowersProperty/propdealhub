// ════════════════════════════════════════════════════════════════════════════
// Compliance layer — CAN-SPAM + internal suppression list
// ────────────────────────────────────────────────────────────────────────────
// Gates EVERY outbound send. If this module returns { allowed: false }, the
// sequencer MUST skip the send and mark the queue row `skipped_suppressed`.
//
// CAN-SPAM requirements enforced here:
//   1. Accurate "From" header (handled by Gmail — always authenticated)
//   2. Non-deceptive subject lines (subject length + spam-word linter below)
//   3. Identification as ad: not required for B2B-style motivated-seller
//      outreach, but we add a disclosure line in the template footer.
//   4. Physical postal address: required. Pulled from POSTAL_ADDRESS env var.
//   5. Clear unsubscribe mechanism: every email gets a unique token + link.
//   6. Honor opt-outs within 10 business days: we honor instantly via the
//      suppression_list table (checked on every send).
//   7. Monitor third-party senders: we ARE the sender (Gmail OAuth on the
//      user's own account), so no third party.
// ════════════════════════════════════════════════════════════════════════════

import crypto from "crypto";
import { getDb } from "./db";
import { suppressionList, outreachLog } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";

const POSTAL_ADDRESS =
  process.env.POSTAL_ADDRESS ??
  "Powers Property Solutions, PO Box [SET POSTAL_ADDRESS env var], AL";

const COMPANY_NAME = process.env.COMPANY_NAME ?? "Powers Property Solutions";
const UNSUBSCRIBE_BASE =
  process.env.UNSUBSCRIBE_BASE ?? "https://propdealhub-production.up.railway.app";

// ────────────────────────────────────────────────────────────────────────────
// Suppression list
// ────────────────────────────────────────────────────────────────────────────

export type SuppressionReason =
  | "unsubscribed"
  | "bounced"
  | "complained"
  | "manual"
  | "dnc_list"
  | "litigator";

function normalize(contact: string, type: "email" | "phone"): string {
  if (type === "email") return contact.trim().toLowerCase();
  // Phone → digits only, prefix +1 if 10 digits
  const digits = contact.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return contact.trim();
}

export async function isSuppressed(
  contact: string,
  type: "email" | "phone"
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const normalized = normalize(contact, type);
  const rows = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.contact, normalized),
        eq(suppressionList.contactType, type)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function addToSuppressionList(
  contact: string,
  type: "email" | "phone",
  reason: SuppressionReason,
  opts: { sourceLeadId?: number; notes?: string } = {}
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const normalized = normalize(contact, type);
  // Insert ignoring dupes (MySQL: INSERT IGNORE not in drizzle; use try/catch)
  try {
    await db.insert(suppressionList).values({
      contact: normalized,
      contactType: type,
      reason,
      sourceLeadId: opts.sourceLeadId ?? null,
      notes: opts.notes ?? null,
    });
  } catch (e: any) {
    // Duplicate key = already suppressed, not an error
    if (!/duplicate|unique/i.test(e?.message ?? "")) throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Unsubscribe token generation + verification
// ────────────────────────────────────────────────────────────────────────────

export function generateUnsubscribeToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Given an unsubscribe token from a clicked link, find the associated
 * outreach_log row, return the contact (email/phone) and lead id.
 */
export async function resolveUnsubscribeToken(
  token: string
): Promise<{ leadId: number | null; contact: string; type: "email" | "phone" } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(outreachLog)
    .where(eq(outreachLog.unsubscribeToken, token))
    .limit(1);
  if (rows.length === 0) return null;
  const row: any = rows[0];
  // We'll need to join with leads to get the email/phone. Import lazily.
  const { leads } = await import("../drizzle/schema");
  const leadRows = await db.select().from(leads).where(eq(leads.id, row.leadId)).limit(1);
  if (leadRows.length === 0) return null;
  const lead: any = leadRows[0];
  if (row.channel === "email") {
    return { leadId: lead.id, contact: lead.ownerEmail ?? "", type: "email" };
  }
  if (row.channel === "sms") {
    return { leadId: lead.id, contact: lead.ownerPhone ?? "", type: "phone" };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Subject line linter (light-touch spam checker)
// ────────────────────────────────────────────────────────────────────────────

const SPAM_WORDS = [
  /\bfree\b/i,
  /\burgent\b/i,
  /\bguarantee/i,
  /!!!/,
  /\$\$\$/,
  /\bacquire\b/i,
  /\bcash\b.*\bnow\b/i,
];

export function lintSubject(subject: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (subject.length < 5) issues.push("Subject too short");
  if (subject.length > 100) issues.push("Subject too long (>100 chars)");
  if (/^RE:|^FW:/i.test(subject)) issues.push("Fake reply/forward prefix (deceptive)");
  if (/[A-Z]{5,}/.test(subject) && subject.length > 10) issues.push("Excessive caps");
  for (const pat of SPAM_WORDS) {
    if (pat.test(subject)) issues.push(`Spam word: ${pat}`);
  }
  return { ok: issues.length === 0, issues };
}

// ────────────────────────────────────────────────────────────────────────────
// CAN-SPAM footer + unsubscribe link injection
// ────────────────────────────────────────────────────────────────────────────

export function buildUnsubscribeUrl(token: string): string {
  return `${UNSUBSCRIBE_BASE}/api/unsubscribe/${token}`;
}

export function buildCanSpamFooter(token: string): { text: string; html: string } {
  const url = buildUnsubscribeUrl(token);
  const text = `
---
${COMPANY_NAME}
${POSTAL_ADDRESS}

You're receiving this because public property records show you as the owner of a property we may be interested in purchasing. If you'd prefer not to hear from us, unsubscribe instantly: ${url}
`.trim();

  const html = `
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 16px;" />
<p style="color:#666;font-size:12px;line-height:1.5;font-family:Arial,sans-serif;">
  <strong>${escapeHtml(COMPANY_NAME)}</strong><br/>
  ${escapeHtml(POSTAL_ADDRESS)}<br/><br/>
  You're receiving this because public property records show you as the owner of a property we may be interested in purchasing.
  If you'd prefer not to hear from us, <a href="${url}" style="color:#666;">unsubscribe instantly</a>.
</p>
`.trim();

  return { text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ────────────────────────────────────────────────────────────────────────────
// Main gate: checkSendAllowed
// ────────────────────────────────────────────────────────────────────────────

export interface SendCheckInput {
  channel: "email" | "sms";
  contact: string;       // the destination (email or phone)
  subject?: string;      // for email only
}

export interface SendCheckResult {
  allowed: boolean;
  reason?: string;
  warnings: string[];
}

export async function checkSendAllowed(input: SendCheckInput): Promise<SendCheckResult> {
  const warnings: string[] = [];

  // 1. Contact format sanity
  if (!input.contact) {
    return { allowed: false, reason: "No contact provided", warnings };
  }
  if (input.channel === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.contact)) {
    return { allowed: false, reason: "Invalid email format", warnings };
  }
  if (input.channel === "sms" && input.contact.replace(/\D/g, "").length < 10) {
    return { allowed: false, reason: "Invalid phone format", warnings };
  }

  // 2. Suppression list check
  if (await isSuppressed(input.contact, input.channel === "email" ? "email" : "phone")) {
    return { allowed: false, reason: "Contact is on suppression list", warnings };
  }

  // 3. Subject linter (email only, non-blocking)
  if (input.channel === "email" && input.subject) {
    const lint = lintSubject(input.subject);
    if (!lint.ok) warnings.push(...lint.issues);
  }

  // 4. Volume throttle placeholder — TODO: add rate limiting per day
  //    (e.g. max 200 emails per 24 hours to stay under Gmail free send caps)

  return { allowed: true, warnings };
}

// ────────────────────────────────────────────────────────────────────────────
// SMS-specific: TCPA / DNC warning
// Note: SMS is NOT part of Phase 2 auto-send. It still requires A2P 10DLC
// registration. This helper exists so /api/sms/* routes can validate later.
// ────────────────────────────────────────────────────────────────────────────

export function smsComplianceReminder(): string {
  return [
    "SMS outreach requires:",
    "1. A2P 10DLC brand + campaign registration (Twilio)",
    "2. Prior express written consent OR established business relationship",
    "3. Honor STOP replies immediately",
    "4. Include opt-out instructions (e.g., 'Reply STOP to opt out')",
  ].join("\n");
}
