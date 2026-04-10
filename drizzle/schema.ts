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

  // Pipeline stage (expanded from original 4-status)
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

  // Deal intelligence
  dealScore: float("dealScore"),          // 0.0 – 10.0, auto-calculated on ingest
  isUrgent: boolean("isUrgent").default(false).notNull(), // equity > $40k OR auction < 30 days
  auctionDate: timestamp("auctionDate"),  // for pre-foreclosures
  daysToAuction: int("daysToAuction"),    // computed on ingest

  // Owner info (from skip trace)
  ownerName: varchar("ownerName", { length: 255 }),
  ownerPhone: varchar("ownerPhone", { length: 30 }),
  ownerEmail: varchar("ownerEmail", { length: 320 }),
  ownerMailingAddress: text("ownerMailingAddress"),
  skipTraceStatus: mysqlEnum("skipTraceStatus", ["none", "pending", "complete", "failed"]).default("none").notNull(),

  // Notes and raw data
  notes: text("notes"),
  rawData: text("rawData"),
  walkthroughData: text("walkthroughData"), // JSON: { items: WalkthroughItem[], redFlagCount, decision, savedAt }

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;

// ─── Outreach Log ──────────────────────────────────────────────────────────────
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
