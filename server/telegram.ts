/**
 * Telegram alert helper for PropDealHub.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 * If not configured, alerts are silently skipped.
 */

interface TelegramAlertPayload {
  leadId: number;
  address: string;
  city: string;
  state: string;
  dealScore: number;
  isUrgent: boolean;
  leadType: string;
  equity: number | null;
  daysToAuction: number | null;
  customMessage?: string; // Override the default message (e.g. for inbound SMS replies)
}

export async function sendTelegramAlert(payload: TelegramAlertPayload): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[Telegram] Not configured — skipping alert for lead", payload.leadId);
    return;
  }

  const urgentTag = payload.isUrgent ? "🔴 URGENT" : "🟡 HOT";
  const leadTypeLabel: Record<string, string> = {
    preforeclosure: "Pre-Foreclosure",
    absentee: "Absentee Owner",
    vacant: "Vacant",
    taxdelinquent: "Tax Delinquent",
    pricedrop: "Price Drop",
  };

  // If a custom message is provided (e.g. inbound SMS reply), send that directly
  if (payload.customMessage) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: payload.customMessage }),
    });
    if (!response.ok) console.error("[Telegram] Failed to send custom alert:", await response.text());
    else console.log("[Telegram] Custom alert sent for lead", payload.leadId);
    return;
  }

  const lines = [
    `${urgentTag} New Lead — Score ${payload.dealScore}/10`,
    ``,
    `📍 ${payload.address}`,
    `   ${payload.city}, ${payload.state}`,
    ``,
    `🏷️ Type: ${leadTypeLabel[payload.leadType] ?? payload.leadType}`,
    payload.equity !== null ? `📊 Equity: ${payload.equity.toFixed(1)}%` : null,
    payload.daysToAuction !== null ? `⏰ Auction in ${payload.daysToAuction} days` : null,
    ``,
    `🔗 View: ${process.env.APP_URL ?? "https://propdealhub.up.railway.app"}/leads/${payload.leadId}`,
  ].filter(Boolean).join("\n");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("[Telegram] Failed to send alert:", err);
  } else {
    console.log("[Telegram] Alert sent for lead", payload.leadId);
  }
}
