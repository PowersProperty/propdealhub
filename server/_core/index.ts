import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { insertLead, rescoreAllLeads } from "../db";
import { sendTelegramAlert } from "../telegram";
import { scoreLead, computeDaysToAuction, deriveDistressFlags, type LeadType } from "../scoring";
import { runPreset, runPullJob, FILTER_PRESETS } from "../batchdata";
import { buildAuthorizeUrl, exchangeCodeForTokens, storeTokens, testGmailConnection } from "../gmail-sender";
import { resolveUnsubscribeToken, addToSuppressionList } from "../compliance";
import { qualifyAll, qualifyLead, tick, listReviewQueue, approveQueueItem, rejectQueueItem, editQueueItem } from "../sequencer";

const APP_UNLOCK_COOKIE = "pdh_unlocked";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(cookieParser());

  // ââ Password gate endpoints âââââââââââââââââââââââââââââââââââââââââââââââ
  app.post("/api/auth/unlock", (req, res) => {
    const { password } = req.body ?? {};
    const expected = process.env.APP_PASSWORD ?? "deals";
    if (!password || password !== expected) {
      return res.status(401).json({ error: "Incorrect password" });
    }
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie(APP_UNLOCK_COOKIE, "1", {
      httpOnly: true,
      path: "/",
      sameSite: "none",
      secure: isSecure,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    });
    return res.json({ success: true });
  });

  app.get("/api/auth/check", (req, res) => {
    const unlocked = req.cookies?.[APP_UNLOCK_COOKIE] === "1";
    return res.json({ unlocked });
  });

  app.post("/api/auth/lock", (req, res) => {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.clearCookie(APP_UNLOCK_COOKIE, {
      httpOnly: true,
      path: "/",
      sameSite: "none",
      secure: isSecure,
    });
    return res.json({ success: true });
  });

  registerOAuthRoutes(app);

  // ââ Webhook ingestion (Phase 1: new scoring engine) âââââââââââââââââââââ
  app.post("/api/leads/ingest", async (req, res) => {
    try {
      const secret = req.headers["x-webhook-secret"] || req.body?.secret;
      const expectedSecret = process.env.WEBHOOK_SECRET ?? "propstream2026";
      if (secret !== expectedSecret) {
        return res.status(401).json({ error: "Unauthorized: invalid secret" });
      }

      const { address, city, state, zip, price, equity, leadType, source } = req.body;

      if (!address || !city || !state || !zip || !leadType || !source) {
        return res.status(400).json({
          error: "Missing required fields: address, city, state, zip, leadType, source"
        });
      }

      const validLeadTypes = ["preforeclosure", "absentee", "vacant", "taxdelinquent", "otc_tax_lien", "pricedrop"];
      if (!validLeadTypes.includes(leadType)) {
        return res.status(400).json({
          error: `Invalid leadType. Must be one of: ${validLeadTypes.join(", ")}`
        });
      }

      // Parse numeric fields
      const parsedPrice = price ? parseInt(String(price), 10) : null;
      const parsedEquity = equity ? parseFloat(String(equity)) : null;
      const parsedEstimatedValue = req.body.estimatedValue ? parseInt(String(req.body.estimatedValue), 10) : null;
      const parsedMortgageBalance = req.body.mortgageBalance ? parseInt(String(req.body.mortgageBalance), 10) : null;
      const parsedAuctionDate = req.body.auctionDate ? new Date(req.body.auctionDate) : null;
      const daysToAuction = computeDaysToAuction(parsedAuctionDate);

      // Optional owner fields that may come from pre-enriched PropStream data
      const ownerName = req.body.ownerName ? String(req.body.ownerName) : null;
      const ownerPhone = req.body.ownerPhone ? String(req.body.ownerPhone) : null;
      const ownerEmail = req.body.ownerEmail ? String(req.body.ownerEmail) : null;
      const ownerMailingAddress = req.body.ownerMailingAddress ? String(req.body.ownerMailingAddress) : null;
      const skipTraceStatus = (ownerPhone || ownerEmail) ? "complete" : "none";

      // Derive distress flags for stacking bonus
      const distressFlags = deriveDistressFlags(leadType as LeadType, {
        isVacant: req.body.isVacant === true || leadType === "vacant",
        isAbsentee: req.body.isAbsentee === true || leadType === "absentee",
        hasTaxLien: req.body.hasTaxLien === true || leadType === "taxdelinquent" || leadType === "otc_tax_lien",
        isPreforeclosure: req.body.isPreforeclosure === true || leadType === "preforeclosure",
      });

      // Run the scoring engine
      const score = scoreLead({
        leadType: leadType as LeadType,
        distressFlags,
        equity: parsedEquity,
        price: parsedPrice,
        estimatedValue: parsedEstimatedValue,
        mortgageBalance: parsedMortgageBalance,
        auctionDate: parsedAuctionDate,
        daysToAuction,
        createdAt: new Date(),
        pipelineStage: "new_lead",
        skipTraceStatus,
        ownerPhone,
        ownerEmail,
        ownerMailingAddress,
      });

      console.log(`[Ingest] Scoring ${address}, ${city}:`);
      score.reasoning.forEach(line => console.log(`  ${line}`));

      const leadId = await insertLead({
        address: String(address),
        city: String(city),
        state: String(state),
        zip: String(zip),
        price: parsedPrice,
        equity: parsedEquity !== null ? String(parsedEquity) : null,
        estimatedValue: parsedEstimatedValue,
        mortgageBalance: parsedMortgageBalance,
        leadType: leadType as any,
        source: String(source || "Propwire"),
        pipelineStage: "new_lead",
        dealScore: score.dealScore,
        motivationScore: score.motivationScore,
        economicsScore: score.economicsScore,
        urgencyScore: score.urgencyScore,
        reachabilityScore: score.reachabilityScore,
        distressFlags,
        lastScoredAt: new Date(),
        isUrgent: score.isUrgent,
        auctionDate: parsedAuctionDate,
        daysToAuction,
        ownerName,
        ownerPhone,
        ownerEmail,
        ownerMailingAddress,
        skipTraceStatus,
        rawData: JSON.stringify(req.body),
      });

      // Send Telegram alert for urgent or high-score leads
      if (score.isUrgent || score.dealScore >= 8) {
        sendTelegramAlert({
          leadId,
          address: String(address),
          city: String(city),
          state: String(state),
          dealScore: score.dealScore,
          isUrgent: score.isUrgent,
          leadType,
          equity: parsedEquity,
          daysToAuction,
        }).catch(console.error);
      }

      return res.status(200).json({
        success: true,
        message: "Lead ingested",
        leadId,
        dealScore: score.dealScore,
        isUrgent: score.isUrgent,
        breakdown: {
          motivation: score.motivationScore,
          economics: score.economicsScore,
          urgency: score.urgencyScore,
          reachability: score.reachabilityScore,
        },
      });
    } catch (err) {
      console.error("[Webhook] Error ingesting lead:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ââ Twilio Inbound SMS Webhook âââââââââââââââââââââââââââââââââââââââââ
  app.post("/api/sms/reply", async (req, res) => {
    try {
      const from: string = req.body?.From ?? "";
      const body: string = req.body?.Body ?? "";
      const to: string = req.body?.To ?? "";

      console.log(`[SMS Inbound] From: ${from} | To: ${to} | Body: ${body}`);

      if (!from || !body) {
        res.set("Content-Type", "text/xml");
        return res.status(200).send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
      }

      const { getDb } = await import("../db");
      const { outreachLog, leads } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");

      const db = await getDb();
      if (db) {
        const matchingLeads = await db.select().from(leads)
          .where(eq(leads.ownerPhone, from))
          .limit(1);

        const leadId = matchingLeads[0]?.id ?? null;

        await db.insert(outreachLog).values({
          leadId: leadId ?? 0,
          channel: "sms",
          direction: "inbound",
          message: `[REPLY from ${from}]: ${body}`,
          sentAt: new Date(),
        });

        if (leadId && matchingLeads[0]) {
          const lead = matchingLeads[0];
          sendTelegramAlert({
            leadId,
            address: lead.address,
            city: lead.city,
            state: lead.state,
            dealScore: lead.dealScore ?? 0,
            isUrgent: lead.isUrgent ?? false,
            leadType: lead.leadType,
            equity: lead.equity ? parseFloat(lead.equity) : null,
            daysToAuction: lead.daysToAuction ?? null,
            customMessage: `ð© SMS Reply from ${from}:\n"${body}"`
          }).catch(console.error);
        }
      }

      res.set("Content-Type", "text/xml");
      return res.status(200).send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
    } catch (err) {
      console.error("[SMS Reply] Error:", err);
      res.set("Content-Type", "text/xml");
      return res.status(200).send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
    }
  });

  // ââ Daily rescore cron (HTTP endpoint for Railway cron) âââââââââââââââââ
  // Hit by cron daily to apply time-based scoring decay (daysToAuction, age)
  // Example: curl -X POST https://propdealhub-production.up.railway.app/api/leads/rescore-all \
  //   -H "x-webhook-secret: propstream2026"
  app.post("/api/leads/rescore-all", async (req, res) => {
    try {
      const secret = req.headers["x-webhook-secret"] || req.body?.secret;
      const expectedSecret = process.env.WEBHOOK_SECRET ?? "propstream2026";
      if (secret !== expectedSecret) {
        return res.status(401).json({ error: "Unauthorized: invalid secret" });
      }

      const result = await rescoreAllLeads();
      console.log(`[Cron] Rescored all leads:`, result);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("[Cron] Rescore failed:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: One-shot migration bootstrap (safe to re-run â uses IF NOT EXISTS)
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  app.post("/api/admin/bootstrap-phase2-migration", async (req, res) => {
    try {
      const secret = req.headers["x-admin-secret"] || req.query?.secret;
      const expected = process.env.WEBHOOK_SECRET ?? "propstream2026";
      if (secret !== expected) return res.status(401).json({ error: "Unauthorized" });

      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB unavailable" });

      const results: any[] = [];

      const statements = [
        `CREATE TABLE IF NOT EXISTS \`suppression_list\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`contact\` VARCHAR(320) NOT NULL,
          \`contact_type\` ENUM('email','phone') NOT NULL,
          \`reason\` ENUM('unsubscribed','bounced','complained','manual','dnc_list','litigator') NOT NULL,
          \`source_lead_id\` INT NULL,
          \`notes\` TEXT NULL,
          \`suppressed_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY \`uq_contact\` (\`contact\`, \`contact_type\`),
          INDEX \`idx_contact_lookup\` (\`contact\`)
        )`,
        `CREATE TABLE IF NOT EXISTS \`gmail_tokens\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`gmail_address\` VARCHAR(320) NOT NULL UNIQUE,
          \`access_token\` TEXT NOT NULL,
          \`refresh_token\` TEXT NOT NULL,
          \`expires_at\` TIMESTAMP NOT NULL,
          \`scope\` TEXT NOT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS \`outreach_queue\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`lead_id\` INT NOT NULL,
          \`channel\` ENUM('email','sms') NOT NULL,
          \`template_id\` VARCHAR(64) NOT NULL,
          \`subject\` VARCHAR(500) NULL,
          \`rendered_body\` TEXT NOT NULL,
          \`tier\` ENUM('auto','review') NOT NULL,
          \`status\` ENUM('pending','approved','rejected','sent','failed','skipped_suppressed') NOT NULL DEFAULT 'pending',
          \`scheduled_for\` TIMESTAMP NULL,
          \`reviewed_by\` VARCHAR(320) NULL,
          \`reviewed_at\` TIMESTAMP NULL,
          \`sent_at\` TIMESTAMP NULL,
          \`unsubscribe_token\` VARCHAR(128) NULL,
          \`failure_reason\` TEXT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX \`idx_status_scheduled\` (\`status\`, \`scheduled_for\`),
          INDEX \`idx_lead\` (\`lead_id\`)
        )`,
        `CREATE TABLE IF NOT EXISTS \`batchdata_pulls\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`pulled_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`filter_name\` VARCHAR(100) NOT NULL,
          \`search_criteria\` TEXT NOT NULL,
          \`total_results\` INT NOT NULL DEFAULT 0,
          \`new_leads_created\` INT NOT NULL DEFAULT 0,
          \`duplicates_skipped\` INT NOT NULL DEFAULT 0,
          \`skip_trace_matches\` INT NOT NULL DEFAULT 0,
          \`cost_cents\` INT NOT NULL DEFAULT 0,
          \`error\` TEXT NULL
        )`,
      ];

      for (const stmt of statements) {
        try {
          await (db as any).execute(sql.raw(stmt));
          const tableName = stmt.match(/`(\w+)`/)?.[1];
          results.push({ table: tableName, ok: true });
        } catch (e: any) {
          results.push({ stmt: stmt.slice(0, 60), error: String(e?.message ?? e) });
        }
      }

      // Extend outreach_log (use try/catch per column since IF NOT EXISTS isn't universally supported on ADD COLUMN)
      const alters = [
        "ALTER TABLE `outreach_log` ADD COLUMN `template_id` VARCHAR(64) NULL",
        "ALTER TABLE `outreach_log` ADD COLUMN `unsubscribe_token` VARCHAR(128) NULL",
        "ALTER TABLE `outreach_log` ADD COLUMN `gmail_message_id` VARCHAR(255) NULL",
        "ALTER TABLE `outreach_log` ADD COLUMN `subject` VARCHAR(500) NULL",
        "CREATE INDEX `idx_outreach_unsub` ON `outreach_log`(`unsubscribe_token`)",
      ];

      for (const stmt of alters) {
        try {
          await (db as any).execute(sql.raw(stmt));
          results.push({ alter: stmt.slice(0, 60), ok: true });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          // Duplicate column/index errors are fine â migration is idempotent
          const isDup = msg.includes("Duplicate") || msg.includes("exists");
          results.push({ alter: stmt.slice(0, 60), ok: isDup, skipped: isDup, error: isDup ? undefined : msg });
        }
      }

      return res.json({ success: true, results });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: Helper â admin auth via webhook secret
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const requireAdmin = (req: any, res: any, next: () => void) => {
    const secret = req.headers["x-admin-secret"] || req.query?.secret;
    const expected = process.env.WEBHOOK_SECRET ?? "propstream2026";
    if (secret !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: BatchData ingestion endpoints
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  app.post("/api/batchdata/pull/:preset", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const presetName = req.params.preset;
        if (!(presetName in FILTER_PRESETS)) {
          return res.status(400).json({
            error: `Unknown preset. Available: ${Object.keys(FILTER_PRESETS).join(", ")}`,
          });
        }
        const result = await runPreset(presetName as any);
        return res.json(result);
      } catch (e: any) {
        console.error("[BatchData] pull error:", e);
        return res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.post("/api/batchdata/pull", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const { filterName, criteria, options } = req.body ?? {};
        if (!filterName || !criteria) {
          return res.status(400).json({ error: "filterName and criteria required" });
        }
        const result = await runPullJob(filterName, criteria, options ?? {});
        return res.json(result);
      } catch (e: any) {
        console.error("[BatchData] custom pull error:", e);
        return res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.get("/api/batchdata/presets", (_req, res) => {
    res.json({ presets: Object.keys(FILTER_PRESETS), details: FILTER_PRESETS });
  });

  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: Gmail OAuth flow
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  app.get("/api/auth/gmail/authorize", (req, res) => {
    try {
      const url = buildAuthorizeUrl(String(req.query?.state ?? ""));
      res.redirect(url);
    } catch (e: any) {
      res.status(500).send(`OAuth setup error: ${e?.message ?? e}`);
    }
  });

  app.get("/api/auth/gmail/callback", async (req, res) => {
    try {
      const code = String(req.query?.code ?? "");
      if (!code) return res.status(400).send("Missing code");
      const tokens = await exchangeCodeForTokens(code);
      await storeTokens({
        gmailAddress: tokens.gmailAddress,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
      });
      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
          <h2>Gmail connected</h2>
          <p>Connected as: <strong>${tokens.gmailAddress}</strong></p>
          <p>You can close this tab. Outreach sends will now work.</p>
        </body></html>
      `);
    } catch (e: any) {
      console.error("[Gmail OAuth] callback error:", e);
      res.status(500).send(`OAuth callback error: ${e?.message ?? e}`);
    }
  });

  app.get("/api/auth/gmail/test", (req, res) =>
    requireAdmin(req, res, async () => {
      const r = await testGmailConnection();
      res.json(r);
    })
  );

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: Unsubscribe (public â no auth) â PATCH 01: hardened 404-safe
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const renderUnsubPage = (res: express.Response, title: string, body: string, status = 200) => {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title} â Powers Property Solutions</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 24px; color: #222; line-height: 1.55; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  p { color: #444; }
  .brand { color: #888; font-size: 13px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px; }
</style></head>
<body>
  <h1>${title}</h1>
  ${body}
  <div class="brand">Powers Property Solutions &middot; 6174 Woodview Lane, McCalla, AL 35111</div>
</body></html>`);
  };

  app.get("/api/unsubscribe/:token", async (req, res) => {
    const token = req.params.token;

    if (!token || token.length < 8) {
      return renderUnsubPage(
        res,
        "Link not recognized",
        "<p>This unsubscribe link is invalid or expired. If you're trying to stop emails from us, please reply to any message with the word STOP and we'll remove you.</p>",
        404
      );
    }

    // Resolve token defensively â any throw = 404, not 500
    let resolved: Awaited<ReturnType<typeof resolveUnsubscribeToken>> = null;
    try {
      resolved = await resolveUnsubscribeToken(token);
    } catch (e: any) {
      console.warn("[Unsubscribe] token resolve failed:", e?.message ?? e);
      return renderUnsubPage(
        res,
        "Link not recognized",
        "<p>This unsubscribe link is invalid or expired. Reply STOP to any email from us to be removed.</p>",
        404
      );
    }

    if (!resolved) {
      return renderUnsubPage(
        res,
        "Link not recognized",
        "<p>This unsubscribe link is invalid or expired. Reply STOP to any email from us to be removed.</p>",
        404
      );
    }

    try {
      if (resolved.contact) {
        await addToSuppressionList(resolved.contact, resolved.type, "unsubscribed", {
          sourceLeadId: resolved.leadId ?? undefined,
          notes: "Clicked unsubscribe link",
        });
      }
      return renderUnsubPage(
        res,
        "Unsubscribed",
        `<p>You've been removed from our mailing list. You will not receive further emails at <strong>${resolved.contact}</strong>.</p><p>If this was a mistake, reply to any previous email from Chris Powers and we'll sort it out.</p>`,
        200
      );
    } catch (e: any) {
      console.error("[Unsubscribe] suppression failed:", e);
      return renderUnsubPage(
        res,
        "Something went wrong",
        "<p>We hit an error processing your request. Please reply STOP to any email from us and we'll remove you manually.</p>",
        500
      );
    }
  });

  app.post("/api/unsubscribe/:token", async (req, res) => {
    const token = req.params.token;
    if (!token || token.length < 8) return res.status(404).send("Invalid token");

    let resolved: Awaited<ReturnType<typeof resolveUnsubscribeToken>> = null;
    try {
      resolved = await resolveUnsubscribeToken(token);
    } catch {
      return res.status(404).send("Invalid token");
    }
    if (!resolved) return res.status(404).send("Invalid token");

    try {
      if (resolved.contact) {
        await addToSuppressionList(resolved.contact, resolved.type, "unsubscribed", {
          sourceLeadId: resolved.leadId ?? undefined,
        });
      }
      res.status(200).send("OK");
    } catch (e: any) {
      res.status(500).send(String(e?.message ?? e));
    }
  });

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 2: Outreach queue + tick
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  app.post("/api/outreach/qualify/:leadId", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const leadId = parseInt(req.params.leadId, 10);
        const r = await qualifyLead(leadId);
        res.json(r);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.post("/api/outreach/qualify-all", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const r = await qualifyAll();
        res.json(r);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.post("/api/outreach/tick", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const limit = parseInt(String(req.query?.limit ?? "50"), 10);
        const r = await tick(limit);
        res.json(r);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.get("/api/outreach/queue", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const limit = parseInt(String(req.query?.limit ?? "50"), 10);
        const rows = await listReviewQueue(limit);
        res.json({ items: rows, count: rows.length });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.post("/api/outreach/queue/:id/approve", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const id = parseInt(req.params.id, 10);
        const reviewer = String(req.body?.reviewer ?? "chris");
        await approveQueueItem(id, reviewer);
        res.json({ success: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.post("/api/outreach/queue/:id/reject", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const id = parseInt(req.params.id, 10);
        const reviewer = String(req.body?.reviewer ?? "chris");
        const reason = req.body?.reason ? String(req.body.reason) : undefined;
        await rejectQueueItem(id, reviewer, reason);
        res.json({ success: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  app.patch("/api/outreach/queue/:id", (req, res) =>
    requireAdmin(req, res, async () => {
      try {
        const id = parseInt(req.params.id, 10);
        await editQueueItem(id, {
          subject: req.body?.subject,
          renderedBody: req.body?.renderedBody,
        });
        res.json({ success: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    })
  );

  // ââ tRPC âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
