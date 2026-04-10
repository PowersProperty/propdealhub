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
import { insertLead } from "../db";
import { sendTelegramAlert } from "../telegram";

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
      maxAge: 1000 * 60 * 60 * 24 * 30,
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

  app.post("/api/leads/ingest", async (req, res) => {
    try {
      const secret = req.headers["x-webhook-secret"] || req.body?.secret;
      const expectedSecret = process.env.WEBHOOK_SECRET ?? "propstream2026";
      if (secret !== expectedSecret) {
        return res.status(401).json({ error: "Unauthorized: invalid secret" });
      }
      const { address, city, state, zip, price, equity, leadType, source } = req.body;
      if (!address || !city || !state || !zip || !leadType || !source) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const validLeadTypes = ["preforeclosure","absentee","vacant","taxdelinquent","otc_tax_lien","pricedrop"];
      if (!validLeadTypes.includes(leadType)) {
        return res.status(400).json({ error: "Invalid leadType" });
      }
      const parsedPrice = price ? parseInt(String(price), 10) : null;
      const parsedEquity = equity ? parseFloat(String(equity)) : null;
      let dealScore = 5.0;
      if (parsedEquity !== null) {
        if (parsedEquity >= 60) dealScore += 2.5;
        else if (parsedEquity >= 40) dealScore += 1.5;
        else if (parsedEquity >= 25) dealScore += 0.5;
        else dealScore -= 1.0;
      }
      dealScore = Math.min(10, Math.max(0, parseFloat(dealScore.toFixed(1))));
      const leadId = await insertLead({ address, city, state, zip, price: parsedPrice, equity: parsedEquity !== null ? String(parsedEquity) : null, leadType, source, pipelineStage: "new_lead", dealScore, rawData: JSON.stringify(req.body) });
      return res.status(200).json({ success: true, message: "Lead ingested", leadId, dealScore });
    } catch (err) {
      console.error("[Webhook] Error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/sms/reply", async (req, res) => {
    try {
      const from = req.body?.From ?? "";
      const body = req.body?.Body ?? "";
      const to = req.body?.To ?? "";
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
        const matchingLeads = await db.select().from(leads).where(eq(leads.ownerPhone, from)).limit(1);
        const leadId = matchingLeads[0]?.id ?? null;
        await db.insert(outreachLog).values({ leadId: leadId ?? 0, channel: "sms", direction: "inbound", message: `[REPLY from ${from}]: ${body}`, sentAt: new Date() });
        if (leadId && matchingLeads[0]) {
          const lead = matchingLeads[0];
          sendTelegramAlert({ leadId, address: lead.address, city: lead.city, state: lead.state, dealScore: lead.dealScore ?? 0, isUrgent: lead.isUrgent ?? false, leadType: lead.leadType, equity: lead.equity ? parseFloat(lead.equity) : null, daysToAuction: lead.daysToAuction ?? null, customMessage: `SMS Reply from ${from}: ${body}` }).catch(console.error);
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

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  server.listen(port, () => { console.log(`Server running on http://localhost:${port}/`); });
}

startServer().catch(console.error);
