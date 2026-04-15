// ════════════════════════════════════════════════════════════════════════════
// Gmail OAuth Sender
// ────────────────────────────────────────────────────────────────────────────
// Sends email on behalf of the user (powersproperty25@gmail.com) via Gmail API
// using OAuth 2.0 refresh-token flow.
//
// Env vars required:
//   GMAIL_OAUTH_CLIENT_ID
//   GMAIL_OAUTH_CLIENT_SECRET
//   GMAIL_OAUTH_REDIRECT_URI    (e.g. https://propdealhub-production.up.railway.app/api/auth/gmail/callback)
//   GMAIL_SENDER_ADDRESS         (e.g. powersproperty25@gmail.com)
//
// First-time setup flow (user):
//   1. Navigate to /api/auth/gmail/authorize
//   2. Sign in with powersproperty25@gmail.com, grant scope
//   3. Google redirects to /api/auth/gmail/callback with code
//   4. Callback exchanges code → refresh token → stores in gmail_tokens table
//
// After that, sendEmail() works forever (refresh token auto-renews access token).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from "./db";
import { gmailTokens } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const GOOGLE_OAUTH_BASE = "https://oauth2.googleapis.com";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

// ────────────────────────────────────────────────────────────────────────────
// Env helpers
// ────────────────────────────────────────────────────────────────────────────

function cfg() {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI;
  const sender = process.env.GMAIL_SENDER_ADDRESS;
  if (!clientId || !clientSecret || !redirectUri || !sender) {
    throw new Error(
      "Gmail OAuth env vars missing: GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REDIRECT_URI, GMAIL_SENDER_ADDRESS"
    );
  }
  return { clientId, clientSecret, redirectUri, sender };
}

// ────────────────────────────────────────────────────────────────────────────
// OAuth flow URLs
// ────────────────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(state: string = ""): string {
  const { clientId, redirectUri } = cfg();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // returns refresh_token
    prompt: "consent",         // force refresh_token on re-auth
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  gmailAddress: string;
}> {
  const { clientId, clientSecret, redirectUri } = cfg();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(`${GOOGLE_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${res.status} ${t}`);
  }
  const json: any = await res.json();

  // Fetch email from userinfo
  const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${json.access_token}` },
  });
  const ui: any = await uiRes.json().catch(() => ({}));
  const gmailAddress: string = ui?.email ?? "";

  if (!json.refresh_token) {
    throw new Error(
      "No refresh_token returned. Revoke app access at myaccount.google.com → Security → Third-party apps, then re-authorize."
    );
  }

  return { ...json, gmailAddress };
}

// ────────────────────────────────────────────────────────────────────────────
// Token storage
// ────────────────────────────────────────────────────────────────────────────

export async function storeTokens(params: {
  gmailAddress: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const expiresAt = new Date(Date.now() + params.expiresIn * 1000 - 60_000); // 1-min safety margin

  // Upsert by gmail_address
  const existing = await db
    .select()
    .from(gmailTokens)
    .where(eq(gmailTokens.gmailAddress, params.gmailAddress))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(gmailTokens)
      .set({
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        expiresAt,
        scope: params.scope,
      })
      .where(eq(gmailTokens.gmailAddress, params.gmailAddress));
  } else {
    await db.insert(gmailTokens).values({
      gmailAddress: params.gmailAddress,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      expiresAt,
      scope: params.scope,
    });
  }
}

async function getStoredTokens(gmailAddress: string) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const rows = await db
    .select()
    .from(gmailTokens)
    .where(eq(gmailTokens.gmailAddress, gmailAddress))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `No Gmail tokens stored for ${gmailAddress}. Run OAuth flow at /api/auth/gmail/authorize first.`
    );
  }
  return rows[0];
}

// ────────────────────────────────────────────────────────────────────────────
// Refresh access token
// ────────────────────────────────────────────────────────────────────────────

async function refreshAccessToken(gmailAddress: string): Promise<string> {
  const { clientId, clientSecret } = cfg();
  const stored = await getStoredTokens(gmailAddress);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(`${GOOGLE_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail token refresh failed: ${res.status} ${t}`);
  }
  const json: any = await res.json();
  const newAccess: string = json.access_token;
  const expiresIn: number = json.expires_in ?? 3600;

  const db = await getDb();
  if (db) {
    await db
      .update(gmailTokens)
      .set({
        accessToken: newAccess,
        expiresAt: new Date(Date.now() + expiresIn * 1000 - 60_000),
      })
      .where(eq(gmailTokens.gmailAddress, gmailAddress));
  }
  return newAccess;
}

async function getValidAccessToken(gmailAddress: string): Promise<string> {
  const stored = await getStoredTokens(gmailAddress);
  if (new Date(stored.expiresAt).getTime() > Date.now() + 30_000) {
    return stored.accessToken;
  }
  return refreshAccessToken(gmailAddress);
}

// ────────────────────────────────────────────────────────────────────────────
// Build raw RFC 2822 message (multipart/alternative for text + HTML)
// ────────────────────────────────────────────────────────────────────────────

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  listUnsubscribeUrl?: string;
}): string {
  const boundary = `boundary_${Math.random().toString(36).slice(2)}`;
  const headers: string[] = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeMimeHeader(params.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (params.listUnsubscribeUrl) {
    // RFC 2369 + RFC 8058 one-click unsubscribe
    headers.push(`List-Unsubscribe: <${params.listUnsubscribeUrl}>`);
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    params.textBody,
    "",
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    params.htmlBody,
    "",
  ].join("\r\n");

  const closer = `--${boundary}--`;
  return [headers.join("\r\n"), "", textPart, htmlPart, closer].join("\r\n");
}

function encodeMimeHeader(s: string): string {
  // Only encode if non-ASCII present; otherwise leave plain
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(s)) {
    return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
  }
  return s;
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ────────────────────────────────────────────────────────────────────────────
// sendEmail — main entry point
// ────────────────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  unsubscribeUrl?: string;
  fromName?: string;         // "Chris Powers"
  fromAddress?: string;       // defaults to GMAIL_SENDER_ADDRESS
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { sender } = cfg();
  const fromAddress = params.fromAddress ?? sender;
  const from = params.fromName ? `"${params.fromName}" <${fromAddress}>` : fromAddress;

  const accessToken = await getValidAccessToken(fromAddress);

  const mime = buildMimeMessage({
    from,
    to: params.to,
    subject: params.subject,
    textBody: params.textBody,
    htmlBody: params.htmlBody,
    listUnsubscribeUrl: params.unsubscribeUrl,
  });

  const raw = base64Url(Buffer.from(mime, "utf-8"));

  const res = await fetch(`${GMAIL_API_BASE}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail send failed: ${res.status} ${t}`);
  }
  const json: any = await res.json();
  return { messageId: json.id, threadId: json.threadId };
}

// ────────────────────────────────────────────────────────────────────────────
// Connection test
// ────────────────────────────────────────────────────────────────────────────

export async function testGmailConnection(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const { sender } = cfg();
    const access = await getValidAccessToken(sender);
    const res = await fetch(`${GMAIL_API_BASE}/users/me/profile`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (!res.ok) return { ok: false, error: `Status ${res.status}` };
    const json: any = await res.json();
    return { ok: true, email: json.emailAddress };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
