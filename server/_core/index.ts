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

  // ── Password gate endpoints ───────────────────────────────────────────────
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

  // ── Webhook ingestion (Phase 1: new scoring engine) ─────────────────────
  app.post("/api/leads/ingest", async (req, res) => {
    try {
      const secret = req.headers["x-webhook-secret"] || req.body?.secret;
      const expectedSecret = process.env.WEBHOOK_SECRET ?? "propstream2026";
      if (secret !== expectedSecret) {
        return res.status(401).json({ error: "Unauthorized: invalid secret" });
      }

      const { address, city, state, zip, price, equity, leadType, source } = req.body;

      if (!address || !city || !state || !zip || !leadType || !source) {
        return res.status(400).json({ error: "Missing required fields: address, city, state, zip, leadType, source" });
      }

      const validLeadTypes = ["preforeclosure", "absentee", "vacant", "taxdelinquent", "otc_tax_lien", "pricedrop"];
      if (!validLeadTypes.includes(leadType)) {
        return res.status(400).json({ error: `Invalid leadType. Must be one of: ${validLeadTypes.join(", ")}` });
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

  // ── Twilio Inbound SMS Webhook ─────────────────────────────────────────
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
            customMessage: `📩 SMS Reply from ${from}:\n"${body}"`
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

  // ── Daily rescore cron (HTTP endpoint for Railway cron) ─────────────────
  // Hit by cron daily to apply time-based scoring decay (daysToAuction, age)
  // Example: curl -X POST https://propdealhub-production.up.railway.app/api/leads/rescore-all \
  //           -H "x-webhook-secret: propstream2026"
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

  // ── tRPC ─────────────────────────────────────────────────────────────────
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
