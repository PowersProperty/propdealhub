import { eq, desc, asc, like, or, and, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser, users,
  leads, InsertLead, Lead,
  outreachLog, InsertOutreachLog, OutreachLog,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { scoreLead, computeDaysToAuction, type LeadType } from "./scoring";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── User helpers (kept for template compat) ───────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Lead helpers ──────────────────────────────────────────────────────────────

export async function insertLead(lead: InsertLead): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(leads).values(lead);
  return (result as any)[0]?.insertId ?? 0;
}

export type LeadListOpts = {
  sortBy?: string;
  sortDir?: "asc" | "desc";
  search?: string;
  pipelineStage?: string;
  leadType?: string;
  source?: string;
  urgentOnly?: boolean;
};

export async function getAllLeads(opts?: LeadListOpts): Promise<Lead[]> {
  const db = await getDb();
  if (!db) return [];

  const conditions = [];
  if (opts?.search) {
    conditions.push(
      or(
        like(leads.address, `%${opts.search}%`),
        like(leads.city, `%${opts.search}%`),
        like(leads.zip, `%${opts.search}%`),
        like(leads.ownerName, `%${opts.search}%`)
      )
    );
  }
  if (opts?.pipelineStage && opts.pipelineStage !== "all") {
    conditions.push(eq(leads.pipelineStage, opts.pipelineStage as Lead["pipelineStage"]));
  }
  if (opts?.leadType && opts.leadType !== "all") {
    conditions.push(eq(leads.leadType, opts.leadType as Lead["leadType"]));
  }
  if (opts?.source && opts.source !== "all") {
    conditions.push(eq(leads.source, opts.source));
  }
  if (opts?.urgentOnly) {
    conditions.push(eq(leads.isUrgent, true));
  }

  let query = db.select().from(leads);
  // @ts-ignore
  let q = conditions.length > 0
    ? query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : query;

  const sortCol =
    opts?.sortBy === "price" ? leads.price
    : opts?.sortBy === "equity" ? leads.equity
    : opts?.sortBy === "city" ? leads.city
    : opts?.sortBy === "pipelineStage" ? leads.pipelineStage
    : opts?.sortBy === "dealScore" ? leads.dealScore
    : leads.createdAt;

  // @ts-ignore
  q = opts?.sortDir === "asc" ? q.orderBy(asc(sortCol)) : q.orderBy(desc(sortCol));

  return q as unknown as Promise<Lead[]>;
}

export async function getLeadById(id: number): Promise<Lead | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return result[0];
}

export type UpdateLeadData = Partial<Pick<Lead,
  | "pipelineStage"
  | "notes"
  | "ownerName"
  | "ownerPhone"
  | "ownerEmail"
  | "ownerMailingAddress"
  | "skipTraceStatus"
  | "dealScore"
  | "isUrgent"
  | "auctionDate"
  | "daysToAuction"
  | "estimatedValue"
  | "mortgageBalance"
  | "walkthroughData"
>>;

/**
 * Fields that, when changed, should trigger a score recalculation.
 * If any of these change, we rescore after the update.
 */
const SCORE_AFFECTING_FIELDS: Array<keyof UpdateLeadData> = [
  "ownerPhone",
  "ownerEmail",
  "ownerMailingAddress",
  "skipTraceStatus",
  "estimatedValue",
  "mortgageBalance",
  "auctionDate",
  "pipelineStage",
];

export async function updateLead(id: number, data: UpdateLeadData): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check if any score-affecting field is changing
  const affectsScore = Object.keys(data).some(k =>
    SCORE_AFFECTING_FIELDS.includes(k as keyof UpdateLeadData)
  );

  // Recompute daysToAuction if auctionDate changed
  if (data.auctionDate !== undefined) {
    (data as any).daysToAuction = computeDaysToAuction(
      data.auctionDate ? new Date(data.auctionDate as any) : null
    );
  }

  await db.update(leads).set(data).where(eq(leads.id, id));

  // Rescore if needed
  if (affectsScore) {
    await rescoreLead(id);
  }
}

/**
 * Recalculate and persist the score for a single lead.
 * Called automatically on updates to score-affecting fields.
 */
export async function rescoreLead(leadId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return;

  const daysToAuction = computeDaysToAuction(lead.auctionDate);
  const score = scoreLead({
    leadType: lead.leadType as LeadType,
    distressFlags: lead.distressFlags,
    equity: lead.equity ? parseFloat(lead.equity) : null,
    price: lead.price,
    estimatedValue: lead.estimatedValue,
    mortgageBalance: lead.mortgageBalance,
    auctionDate: lead.auctionDate,
    daysToAuction,
    createdAt: lead.createdAt,
    pipelineStage: lead.pipelineStage,
    skipTraceStatus: lead.skipTraceStatus,
    ownerPhone: lead.ownerPhone,
    ownerEmail: lead.ownerEmail,
    ownerMailingAddress: lead.ownerMailingAddress,
  });

  await db.update(leads).set({
    dealScore: score.dealScore,
    motivationScore: score.motivationScore,
    economicsScore: score.economicsScore,
    urgencyScore: score.urgencyScore,
    reachabilityScore: score.reachabilityScore,
    isUrgent: score.isUrgent,
    daysToAuction,
    lastScoredAt: new Date(),
  }).where(eq(leads.id, leadId));

  console.log(`[Rescore] Lead ${leadId}: ${score.dealScore}/10 (M:${score.motivationScore} E:${score.economicsScore} U:${score.urgencyScore} R:${score.reachabilityScore})`);
}

/**
 * Recalculate scores for ALL leads. Intended to be called by a daily cron.
 * Handles time-based decay: daysToAuction countdown, lead age penalty.
 */
export async function rescoreAllLeads(): Promise<{ total: number; updated: number; errors: number }> {
  const db = await getDb();
  if (!db) return { total: 0, updated: 0, errors: 0 };

  const allLeads = await db.select().from(leads).where(
    // Skip dead/closed leads — no point rescoring terminal states
    or(
      eq(leads.pipelineStage, "new_lead"),
      eq(leads.pipelineStage, "contacted"),
      eq(leads.pipelineStage, "conversation_started"),
      eq(leads.pipelineStage, "appointment_scheduled"),
    )!
  );

  let updated = 0;
  let errors = 0;

  for (const lead of allLeads) {
    try {
      await rescoreLead(lead.id);
      updated++;
    } catch (err) {
      console.error(`[Rescore] Failed for lead ${lead.id}:`, err);
      errors++;
    }
  }

  return { total: allLeads.length, updated, errors };
}

export async function deleteLead(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(leads).where(eq(leads.id, id));
}

// ─── Outreach Log helpers ──────────────────────────────────────────────────────

export async function insertOutreach(entry: InsertOutreachLog): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(outreachLog).values(entry);
}

export async function getOutreachByLead(leadId: number): Promise<OutreachLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(outreachLog)
    .where(eq(outreachLog.leadId, leadId))
    .orderBy(desc(outreachLog.sentAt));
}
