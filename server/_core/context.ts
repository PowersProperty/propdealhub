import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

const APP_UNLOCK_COOKIE = "pdh_unlocked";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  unlocked: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  // Simple password gate: check for the unlock cookie set by /api/auth/unlock
  const cookies = (opts.req as any).cookies ?? {};
  const unlocked = cookies[APP_UNLOCK_COOKIE] === "1";

  return {
    req: opts.req,
    res: opts.res,
    unlocked,
  };
}
