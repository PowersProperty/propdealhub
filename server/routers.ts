import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  getAllLeads,
  getLeadById,
  updateLead,
  deleteLead,
  insertOutreach,
  getOutreachByLead,
  rescoreLead,
  rescoreAllLeads,
} from "./db";
import type { Lead } from "../drizzle/schema";

export const appRouter = router({
  system: systemRouter,

  // ── Auth ───────────────────────────────────────────────────────────────────
  auth: router({
    me: publicProcedure.query(opts => {
      return opts.ctx.unlocked ? { unlocked: true } : null;
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const isSecure = ctx.req.secure || ctx.req.headers["x-forwarded-proto"] === "https";
      ctx.res.clearCookie("pdh_unlocked", {
        httpOnly: true,
        path: "/",
        sameSite: "none",
        secure: isSecure,
      });
      return { success: true } as const;
    }),
  }),

  // ── Leads ──────────────────────────────────────────────────────────────────
  leads: router({
    list: protectedProcedure
      .input(z.object({
        sortBy: z.string().optional(),
        sortDir: z.enum(["asc", "desc"]).optional(),
        search: z.string().optional(),
        pipelineStage: z.string().optional(),
        leadType: z.string().optional(),
        source: z.string().optional(),
        urgentOnly: z.boolean().optional(),
      }).optional())
      .query(async ({ input }) => {
        return getAllLeads(input ?? {});
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const lead = await getLeadById(input.id);
        if (!lead) throw new TRPCError({ code: "NOT_FOUND", message: "Lead not found" });
        return lead;
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        pipelineStage: z.enum([
          "new_lead", "contacted", "conversation_started", "appointment_scheduled",
          "property_visit", "offer_sent", "under_contract", "closed", "dead",
        ]).optional(),
        notes: z.string().optional(),
        ownerName: z.string().optional(),
        ownerPhone: z.string().optional(),
        ownerEmail: z.string().optional(),
        ownerMailingAddress: z.string().optional(),
        skipTraceStatus: z.enum(["none", "pending", "complete", "failed"]).optional(),
        dealScore: z.number().min(0).max(10).optional(),
        isUrgent: z.boolean().optional(),
        walkthroughData: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateLead(id, data);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteLead(input.id);
        return { success: true };
      }),

    // ── Scoring (Phase 1) ──────────────────────────────────────────────────
    // Manual recompute of a single lead's score — call from UI "Re-score" button
    rescore: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await rescoreLead(input.id);
        return { success: true };
      }),

    // Recompute ALL active leads. Normally called by daily cron, but exposed here
    // for manual triggers from the dashboard / admin UI.
    rescoreAll: protectedProcedure
      .mutation(async () => {
        const result = await rescoreAllLeads();
        return result;
      }),

    // Outreach log
    logOutreach: protectedProcedure
      .input(z.object({
        leadId: z.number(),
        channel: z.enum(["sms", "email", "telegram", "voicemail", "direct_mail"]),
        message: z.string(),
        direction: z.enum(["outbound", "inbound"]).optional(),
      }))
      .mutation(async ({ input }) => {
        await insertOutreach({
          leadId: input.leadId,
          channel: input.channel,
          message: input.message,
          direction: input.direction ?? "outbound",
          status: "sent",
        });
        return { success: true };
      }),

    getOutreach: protectedProcedure
      .input(z.object({ leadId: z.number() }))
      .query(async ({ input }) => {
        return getOutreachByLead(input.leadId);
      }),

    // Webhook config
    webhookConfig: protectedProcedure.query(() => {
      return {
        webhookUrl: `/api/leads/ingest`,
        secret: process.env.WEBHOOK_SECRET ?? "propstream2026",
      };
    }),
  }),
});

export type AppRouter = typeof appRouter;
