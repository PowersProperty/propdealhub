import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUnlocked = t.middleware(async opts => {
  const { ctx, next } = opts;
  if (!ctx.unlocked) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please enter the app password (10001)" });
  }
  return next({ ctx });
});

export const protectedProcedure = t.procedure.use(requireUnlocked);
export const adminProcedure = t.procedure.use(requireUnlocked);
