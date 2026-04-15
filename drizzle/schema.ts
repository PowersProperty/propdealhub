import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  decimal,
  boolean,
  float,
  uniqueIndex,
  index,
} from "drizzle-orm/mysql-core";

// ─── Users (kept for template compatibility, not used in password-gate mode) ───
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Leads ─────────────────────────────────────────────────────────────────────
export const leads = mysqlTable("leads", {
  id: int("id").autoincrement().primaryKey(),

  // Property
  address: varchar("address", { length: 255 }).notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  state: varchar("state", { length: 50 }).notNull(),
  zip: varchar("zip", { length: 20 }).notNull(),
  price: int("price"),
  equity: decimal("equity", { precision: 5, scale: 2 }),
  estimatedValue: int("estimatedValue"),
  mortgageBalance: int("mortgageBalance"),
  yearBuilt: int("yearBuilt"),
  sqft: int("sqft"),
  bedrooms: int("bedrooms"),
  bathrooms: decimal("bathrooms", { precision: 3, scale: 1 }),

  // Lead classification
  leadType: mysqlEnum("leadType", ["preforeclosure", "absentee", "vacant", "taxdelinquent", "otc_tax_lien", "pricedrop"]).notNull(),
  source: varchar("source", { length: 100 }).notNull().default("Propwire"),

  // Pipeline stage
  pipelineStage: mysqlEnum("pipelineStage", [
    "new_lead",
    "contacted",
    "conversation_started",
    "appointment_scheduled",
    "property_visit",
    "offer_sent",
    "under_contract",
    "closed",
    "dead",
  ]).default("new_lead").notNull(),

  // Deal intelligence (enhanced scoring system — Phase 1)
  dealScore: float("dealScore"),                   // 0.0 – 10.0, normalized from totalRaw/10
  motivationScore: float("motivationScore"),       // 0-30 raw dimension score
  economicsScore: float("economicsScore"),         // 0-30 raw dimension score
  urgencyScore: float("urgencyScore"),             // 0-20 raw dimension score
  reachabilityScore: float("reachabilityScore"),   // 0-20 raw dimension score
  lastScoredAt: timestamp("lastScoredAt"),         // when score was last recalculated
  distressFlags: varchar("distressFlags", { length: 255 }), // comma-separated: "vacant,taxdelinquent"

  isUrgent: boolean("isUrgent").default(false).notNull(),
  auctionDate: timestamp("auctionDate"),
  daysToAuction: int("daysToAuction"),

  // Owner info (from skip trace)
  ownerName: varchar("ownerName", { length: 255 }),
  ownerPhone: varchar("ownerPhone", { length: 30 }),
  ownerEmail: varchar("ownerEmail", { length: 320 }),
  ownerMailingAddress: text("ownerMailingAddress"),
  skipTraceStatus: mysqlEnum("skipTraceStatus", ["none", "pending", "complete", "failed"]).default("none").notNull(),

  // Notes and raw data
  notes: text("notes"),
  rawData: text("rawData"),
  walkthroughData: text("walkthroughData"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;

// ─── Outreach Log ─────────────────────────────────────────────────────────────
export const outreachLog = mysqlTable("outreach_log", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  channel: mysqlEnum("channel", ["sms", "email", "telegram", "voicemail", "direct_mail"]).notNull(),
  direction: mysqlEnum("direction", ["outbound", "inbound"]).default("outbound").notNull(),
  message: text("message").notNull(),
  status: mysqlEnum("status", ["sent", "delivered", "failed", "replied"]).default("sent").notNull(),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type OutreachLog = typeof outreachLog.$inferSelect;
export type InsertOutreachLog = typeof outreachLog.$inferInsert;

// ════════════════════════════════════════════════════════════════════════════
// Phase 2: Outreach automation
// ════════════════════════════════════════════════════════════════════════════

// ─── Suppression List ──────────────────────────────────────────────────────
export const suppressionList = mysqlTable(
  "suppression_list",
  {
    id: int("id").autoincrement().primaryKey(),
    contact: varchar("contact", { length: 320 }).notNull(),
    contactType: mysqlEnum("contact_type", ["email", "phone"]).notNull(),
    reason: mysqlEnum("reason", [
      "unsubscribed",
      "bounced",
      "complained",
      "manual",
      "dnc_list",
      "litigator",
    ]).notNull(),
    sourceLeadId: int("source_lead_id"),
    notes: text("notes"),
    suppressedAt: timestamp("suppressed_at").defaultNow().notNull(),
  },
  (t) => ({
    uqContact: uniqueIndex("uq_contact").on(t.contact, t.contactType),
    idxContact: index("idx_contact_lookup").on(t.contact),
  })
);

export type SuppressionEntry = typeof suppressionList.$inferSelect;
export type InsertSuppressionEntry = typeof suppressionList.$inferInsert;

// ─── Gmail OAuth Tokens ────────────────────────────────────────────────────
export const gmailTokens = mysqlTable("gmail_tokens", {
  id: int("id").autoincrement().primaryKey(),
  gmailAddress: varchar("gmail_address", { length: 320 }).notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  scope: text("scope").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type GmailToken = typeof gmailTokens.$inferSelect;
export type InsertGmailToken = typeof gmailTokens.$inferInsert;

// ─── Outreach Review Queue ─────────────────────────────────────────────────
export const outreachQueue = mysqlTable(
  "outreach_queue",
  {
    id: int("id").autoincrement().primaryKey(),
    leadId: int("lead_id").notNull(),
    channel: mysqlEnum("channel", ["email", "sms"]).notNull(),
    templateId: varchar("template_id", { length: 64 }).notNull(),
    subject: varchar("subject", { length: 500 }),
    renderedBody: text("rendered_body").notNull(),
    tier: mysqlEnum("tier", ["auto", "review"]).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "approved",
      "rejected",
      "sent",
      "failed",
      "skipped_suppressed",
    ])
      .default("pending")
      .notNull(),
    scheduledFor: timestamp("scheduled_for"),
    reviewedBy: varchar("reviewed_by", { length: 320 }),
    reviewedAt: timestamp("reviewed_at"),
    sentAt: timestamp("sent_at"),
    unsubscribeToken: varchar("unsubscribe_token", { length: 128 }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    idxStatus: index("idx_status_scheduled").on(t.status, t.scheduledFor),
    idxLead: index("idx_lead").on(t.leadId),
  })
);

export type OutreachQueueItem = typeof outreachQueue.$inferSelect;
export type InsertOutreachQueueItem = typeof outreachQueue.$inferInsert;

// ─── BatchData Pull Log ────────────────────────────────────────────────────
export const batchdataPulls = mysqlTable("batchdata_pulls", {
  id: int("id").autoincrement().primaryKey(),
  pulledAt: timestamp("pulled_at").defaultNow().notNull(),
  filterName: varchar("filter_name", { length: 100 }).notNull(),
  searchCriteria: text("search_criteria").notNull(),
  totalResults: int("total_results").default(0).notNull(),
  newLeadsCreated: int("new_leads_created").default(0).notNull(),
  duplicatesSkipped: int("duplicates_skipped").default(0).notNull(),
  skipTraceMatches: int("skip_trace_matches").default(0).notNull(),
  costCents: int("cost_cents").default(0).notNull(),
  error: text("error"),
});

export type BatchdataPull = typeof batchdataPulls.$inferSelect;
export type InsertBatchdataPull = typeof batchdataPulls.$inferInsert;
