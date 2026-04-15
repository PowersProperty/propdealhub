// ════════════════════════════════════════════════════════════════════════════
// Email Templates — Motivated Seller Outreach
// ────────────────────────────────────────────────────────────────────────────
// Short, conversational, non-spammy. Deliberately understated subject lines.
// Templates are keyed by leadType + sequence step.
//
// Design principles:
//   • Personal tone — looks like a human wrote it (not marketing copy)
//   • ≤ 80 words body — respects recipient time
//   • No ALL CAPS, no !!!, no "FREE" / "URGENT"
//   • Clear CTA: reply to this email or call a number
//   • Honest framing: "we may be interested in purchasing"
// ════════════════════════════════════════════════════════════════════════════

import { buildCanSpamFooter } from "./compliance";

export interface Lead {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  leadType: string;
  equity?: string | null;
  auctionDate?: Date | null;
  daysToAuction?: number | null;
}

export interface RenderedEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export type TemplateId =
  | "preforeclosure_1"
  | "preforeclosure_2"
  | "absentee_1"
  | "absentee_2"
  | "taxdelinquent_1"
  | "taxdelinquent_2"
  | "vacant_1"
  | "generic_1";

// ────────────────────────────────────────────────────────────────────────────
// Utility: firstName extraction
// ────────────────────────────────────────────────────────────────────────────

function firstName(full?: string | null): string {
  if (!full) return "there";
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return "there";
  const first = parts[0];
  // Title case
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function shortAddress(lead: Lead): string {
  return `${lead.address}, ${lead.city}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Template bodies (text versions; HTML wrapped by renderEmail)
// ────────────────────────────────────────────────────────────────────────────

const TEMPLATES: Record<
  TemplateId,
  (lead: Lead) => { subject: string; text: string }
> = {
  // ── Pre-foreclosure: first touch, empathetic ─────────────────────────────
  preforeclosure_1: (lead) => ({
    subject: `Quick question about ${shortAddress(lead)}`,
    text: `Hi ${firstName(lead.ownerName)},

I'm Chris with Powers Property Solutions here in Alabama. I noticed your property at ${shortAddress(lead)} and wanted to reach out directly.

We work with homeowners in tough spots — sometimes that means a quick cash offer that helps you avoid foreclosure and move on without the bank-sale hit to your credit.

If you'd be open to a no-pressure conversation, just reply to this email or call me at [PHONE]. If not, no worries — I won't keep bothering you.

— Chris Powers
Powers Property Solutions`,
  }),

  preforeclosure_2: (lead) => ({
    subject: `Following up — ${lead.city} property`,
    text: `Hi ${firstName(lead.ownerName)},

Circling back on my note about ${shortAddress(lead)}. I know these situations can feel overwhelming and the last thing you need is more noise.

If there's even a small chance a cash offer could help, I'd like to run the numbers for you — takes about 10 minutes and there's no commitment.

Reply here or call [PHONE] any time.

— Chris`,
  }),

  // ── Absentee owner: investor-to-investor tone ───────────────────────────
  absentee_1: (lead) => ({
    subject: `Your ${lead.city} property`,
    text: `Hi ${firstName(lead.ownerName)},

I'm Chris with Powers Property Solutions. I saw that you own ${shortAddress(lead)} but don't live there, and I wanted to reach out in case you've been thinking about selling.

We buy directly — no agents, no repairs, quick close. If the timing's right I can have a cash offer to you within a couple days.

Worth a conversation? Just reply or call [PHONE].

— Chris Powers`,
  }),

  absentee_2: (lead) => ({
    subject: `RE: ${lead.city} — thought of another option`,
    text: `Hi ${firstName(lead.ownerName)},

Following up on ${shortAddress(lead)}. A few owners I talk to don't want to sell outright but are open to creative terms — owner financing, subject-to, or a lease option.

If any of that's interesting, I'd love to chat. If not, I'll step back.

— Chris`,
  }),

  // ── Tax delinquent: careful, not presumptuous ───────────────────────────
  taxdelinquent_1: (lead) => ({
    subject: `Question about ${shortAddress(lead)}`,
    text: `Hi ${firstName(lead.ownerName)},

I'm Chris with Powers Property Solutions. I came across your property at ${shortAddress(lead)} and wanted to reach out directly in case you're weighing your options.

We buy houses for cash — as-is, no fees — and can close in under 3 weeks if that helps. Happy to answer any questions whether or not you end up selling.

Reply here or call [PHONE].

— Chris Powers`,
  }),

  taxdelinquent_2: (lead) => ({
    subject: `Checking in on ${lead.city}`,
    text: `Hi ${firstName(lead.ownerName)},

Just checking in on my earlier note about ${shortAddress(lead)}. No pressure either way — if it's not the right time, just let me know and I'll leave you alone.

— Chris`,
  }),

  // ── Vacant: direct but friendly ────────────────────────────────────────
  vacant_1: (lead) => ({
    subject: `Your vacant property in ${lead.city}`,
    text: `Hi ${firstName(lead.ownerName)},

I noticed ${shortAddress(lead)} looks vacant and wanted to reach out. Vacant properties can be a real pain — insurance, taxes, upkeep.

If you'd consider a cash offer to close out quickly, I can run numbers today. Totally no-pressure.

Reply here or call [PHONE].

— Chris Powers
Powers Property Solutions`,
  }),

  // ── Generic fallback ────────────────────────────────────────────────────
  generic_1: (lead) => ({
    subject: `Your property at ${shortAddress(lead)}`,
    text: `Hi ${firstName(lead.ownerName)},

I'm Chris with Powers Property Solutions. Reaching out directly in case you've been thinking about selling ${shortAddress(lead)}.

We buy houses for cash, as-is, and can close on your timeline. If there's any interest at all, reply to this email or call me at [PHONE].

— Chris Powers`,
  }),
};

// ────────────────────────────────────────────────────────────────────────────
// Default template picker by leadType + step
// ────────────────────────────────────────────────────────────────────────────

export function pickTemplate(leadType: string, step: number): TemplateId {
  const lt = leadType.toLowerCase();
  if (step <= 1) {
    if (lt === "preforeclosure") return "preforeclosure_1";
    if (lt === "absentee") return "absentee_1";
    if (lt === "taxdelinquent" || lt === "otc_tax_lien") return "taxdelinquent_1";
    if (lt === "vacant") return "vacant_1";
    return "generic_1";
  }
  // step 2
  if (lt === "preforeclosure") return "preforeclosure_2";
  if (lt === "absentee") return "absentee_2";
  if (lt === "taxdelinquent" || lt === "otc_tax_lien") return "taxdelinquent_2";
  return "generic_1";
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer: produces final email (subject + text + HTML) with CAN-SPAM footer
// ────────────────────────────────────────────────────────────────────────────

export function renderEmail(
  lead: Lead,
  templateId: TemplateId,
  unsubscribeToken: string,
  replyPhone: string = ""
): RenderedEmail {
  const fn = TEMPLATES[templateId];
  if (!fn) throw new Error(`Unknown template: ${templateId}`);
  const { subject, text: rawText } = fn(lead);
  const phone = replyPhone || process.env.REPLY_PHONE || "";
  const text = rawText.replace(/\[PHONE\]/g, phone);

  const footer = buildCanSpamFooter(unsubscribeToken);
  const textBody = `${text}\n\n${footer.text}`;

  // Convert newlines to <br/> + paragraphs for HTML version
  const htmlBody = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px;margin:0 auto;padding:16px;">
${text
  .split(/\n\n+/)
  .map(
    (p) =>
      `<p style="margin:0 0 14px;">${p
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>")}</p>`
  )
  .join("\n")}
${footer.html}
</body></html>`;

  return { subject, textBody, htmlBody };
}

// ────────────────────────────────────────────────────────────────────────────
// Template catalog (for review queue UI display)
// ────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_CATALOG: Array<{ id: TemplateId; description: string }> = [
  { id: "preforeclosure_1", description: "Pre-foreclosure, initial touch (empathetic)" },
  { id: "preforeclosure_2", description: "Pre-foreclosure, follow-up" },
  { id: "absentee_1", description: "Absentee owner, initial touch" },
  { id: "absentee_2", description: "Absentee owner, creative-terms follow-up" },
  { id: "taxdelinquent_1", description: "Tax delinquent, initial touch" },
  { id: "taxdelinquent_2", description: "Tax delinquent, soft follow-up" },
  { id: "vacant_1", description: "Vacant property, direct offer" },
  { id: "generic_1", description: "Generic fallback" },
];
