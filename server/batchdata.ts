// ════════════════════════════════════════════════════════════════════════════
// BatchData API Client
// ────────────────────────────────────────────────────────────────────────────
// Pay-per-match model: ~$0.07 per skip-traced record, no monthly fee.
// Docs: https://docs.batchdata.com/
//
// Env vars required:
//   BATCHDATA_API_KEY   — from dashboard.batchdata.com
//
// Exposes:
//   searchProperties(criteria)  — returns property list (no skip trace cost)
//   skipTrace(property)          — paid per-match (~$0.07)
//   runPullJob(filterName, criteria) — end-to-end pull → skip trace → insert
// ════════════════════════════════════════════════════════════════════════════

import { insertLead, getDb } from "./db";
import { batchdataPulls, leads } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";

const BATCHDATA_API_BASE = "https://api.batchdata.com/api/v1";

function apiKey(): string {
  const k = process.env.BATCHDATA_API_KEY;
  if (!k) throw new Error("BATCHDATA_API_KEY is not set");
  return k;
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PropertySearchCriteria {
  // Geographic
  state?: string;          // "AL"
  city?: string;           // "Birmingham"
  zipCodes?: string[];     // ["35242", "35216"]
  counties?: string[];     // ["Jefferson", "Shelby"]

  // Distress signals
  preForeclosure?: boolean;
  taxDelinquent?: boolean;
  highEquity?: boolean;        // >= 50% equity
  absenteeOwner?: boolean;
  vacant?: boolean;

  // Property filters
  minValue?: number;
  maxValue?: number;
  minEquityPercent?: number;   // 0–100
  propertyType?: "single_family" | "multi_family" | "condo" | "all";

  // Paging
  skip?: number;
  take?: number;               // max 1000 per request
}

export interface BatchDataProperty {
  address: { street: string; city: string; state: string; zip: string };
  valuation?: { estimatedValue?: number; equityPercent?: number; mortgageBalance?: number };
  building?: { yearBuilt?: number; totalBuildingAreaSquareFeet?: number; bedroomCount?: number; bathroomCount?: number };
  foreclosure?: { status?: string; auctionDate?: string };
  taxes?: { delinquentYear?: number };
  owner?: { fullName?: string; mailingAddress?: string; occupancy?: string };
  // Skip trace output (populated after skipTrace call)
  skipTraceResult?: {
    matchStatus?: "match" | "no_match";
    phones?: Array<{ number: string; type?: string; doNotCall?: boolean }>;
    emails?: Array<{ email: string }>;
  };
  _raw?: any;
}

export interface PullJobResult {
  pullId: number;
  totalResults: number;
  newLeadsCreated: number;
  duplicatesSkipped: number;
  skipTraceMatches: number;
  estimatedCostCents: number;
  errors: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Property search (no per-record cost; pulls candidates)
// ────────────────────────────────────────────────────────────────────────────

export async function searchProperties(
  criteria: PropertySearchCriteria
): Promise<BatchDataProperty[]> {
  const body: any = {
    searchCriteria: {},
    options: { skip: criteria.skip ?? 0, take: Math.min(criteria.take ?? 100, 1000) },
  };

  // Geographic
  if (criteria.state) body.searchCriteria.state = criteria.state;
  if (criteria.city) body.searchCriteria.city = criteria.city;
  if (criteria.zipCodes?.length) body.searchCriteria.zipCodes = criteria.zipCodes;
  if (criteria.counties?.length) body.searchCriteria.counties = criteria.counties;

  // Distress signals
  if (criteria.preForeclosure) body.searchCriteria.foreclosure = { isActive: true };
  if (criteria.taxDelinquent) body.searchCriteria.taxes = { delinquent: true };
  if (criteria.highEquity || criteria.minEquityPercent) {
    body.searchCriteria.valuation = {
      equityPercent: { min: criteria.minEquityPercent ?? 50 },
    };
  }
  if (criteria.absenteeOwner) body.searchCriteria.owner = { absenteeOwner: true };
  if (criteria.vacant) body.searchCriteria.quickLists = ["vacant"];

  // Value bounds
  if (criteria.minValue || criteria.maxValue) {
    body.searchCriteria.valuation = body.searchCriteria.valuation ?? {};
    body.searchCriteria.valuation.estimatedValue = {};
    if (criteria.minValue) body.searchCriteria.valuation.estimatedValue.min = criteria.minValue;
    if (criteria.maxValue) body.searchCriteria.valuation.estimatedValue.max = criteria.maxValue;
  }

  const res = await fetch(`${BATCHDATA_API_BASE}/property/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`BatchData search failed ${res.status}: ${errText}`);
  }

  const json: any = await res.json();
  const results: any[] = json?.results?.properties ?? json?.properties ?? [];
  return results.map(normalizeProperty);
}

function normalizeProperty(raw: any): BatchDataProperty {
  return {
    address: {
      street: raw?.address?.street ?? raw?.address?.full ?? "",
      city: raw?.address?.city ?? "",
      state: raw?.address?.state ?? "",
      zip: raw?.address?.zip ?? raw?.address?.zipCode ?? "",
    },
    valuation: {
      estimatedValue: raw?.valuation?.estimatedValue ?? raw?.assessment?.estimatedValue,
      equityPercent: raw?.valuation?.equityPercent ?? raw?.equityPercent,
      mortgageBalance: raw?.valuation?.mortgageBalance ?? raw?.loan?.balance,
    },
    building: {
      yearBuilt: raw?.building?.yearBuilt,
      totalBuildingAreaSquareFeet: raw?.building?.totalBuildingAreaSquareFeet,
      bedroomCount: raw?.building?.bedroomCount,
      bathroomCount: raw?.building?.bathroomCount,
    },
    foreclosure: {
      status: raw?.foreclosure?.status,
      auctionDate: raw?.foreclosure?.auctionDate ?? raw?.foreclosure?.saleDate,
    },
    taxes: { delinquentYear: raw?.taxes?.delinquentYear },
    owner: {
      fullName: raw?.owner?.fullName ?? raw?.owner?.name,
      mailingAddress: raw?.owner?.mailingAddress?.full,
      occupancy: raw?.owner?.occupancy,
    },
    _raw: raw,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Skip trace (paid: ~$0.07/match)
// ────────────────────────────────────────────────────────────────────────────

export async function skipTrace(
  property: BatchDataProperty
): Promise<BatchDataProperty> {
  const body = {
    requests: [
      {
        propertyAddress: {
          street: property.address.street,
          city: property.address.city,
          state: property.address.state,
          zip: property.address.zip,
        },
        ownerName: property.owner?.fullName ?? undefined,
      },
    ],
  };

  const res = await fetch(`${BATCHDATA_API_BASE}/property/skip-trace`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`BatchData skip trace failed ${res.status}: ${errText}`);
  }

  const json: any = await res.json();
  const result = json?.results?.persons?.[0] ?? json?.persons?.[0];

  const phones: Array<{ number: string; type?: string; doNotCall?: boolean }> = [];
  const emails: Array<{ email: string }> = [];

  if (result) {
    for (const p of result.phoneNumbers ?? result.phones ?? []) {
      phones.push({
        number: p.number ?? p.phoneNumber ?? p,
        type: p.type,
        doNotCall: Boolean(p.doNotCall ?? p.dnc),
      });
    }
    for (const e of result.emails ?? []) {
      emails.push({ email: e.email ?? e });
    }
  }

  return {
    ...property,
    skipTraceResult: {
      matchStatus: result ? "match" : "no_match",
      phones,
      emails,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Map BatchData → PropDealHub leadType enum
// ────────────────────────────────────────────────────────────────────────────

function classifyLeadType(p: BatchDataProperty): {
  leadType: "preforeclosure" | "absentee" | "vacant" | "taxdelinquent" | "otc_tax_lien" | "pricedrop";
  reason: string;
} {
  if (p.foreclosure?.status && /active|pre|scheduled/i.test(p.foreclosure.status)) {
    return { leadType: "preforeclosure", reason: `foreclosure:${p.foreclosure.status}` };
  }
  if (p.taxes?.delinquentYear) {
    return { leadType: "taxdelinquent", reason: `tax:${p.taxes.delinquentYear}` };
  }
  if (p.owner?.occupancy && /absentee/i.test(p.owner.occupancy)) {
    return { leadType: "absentee", reason: "absentee_owner" };
  }
  if (p._raw?.quickLists?.includes?.("vacant")) {
    return { leadType: "vacant", reason: "vacant" };
  }
  // Fallback
  return { leadType: "absentee", reason: "default_absentee" };
}

// ────────────────────────────────────────────────────────────────────────────
// Dedupe check — have we already ingested this address?
// ────────────────────────────────────────────────────────────────────────────

async function alreadyIngested(address: string, zip: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.address, address), eq(leads.zip, zip)))
    .limit(1);
  return rows.length > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Full pull job — search → skip trace → insert → log
// ────────────────────────────────────────────────────────────────────────────

export async function runPullJob(
  filterName: string,
  criteria: PropertySearchCriteria,
  opts: { skipTraceEnabled?: boolean; maxSkipTraces?: number } = {}
): Promise<PullJobResult> {
  const skipTraceEnabled = opts.skipTraceEnabled ?? true;
  const maxSkipTraces = opts.maxSkipTraces ?? 500;

  const result: PullJobResult = {
    pullId: 0,
    totalResults: 0,
    newLeadsCreated: 0,
    duplicatesSkipped: 0,
    skipTraceMatches: 0,
    estimatedCostCents: 0,
    errors: [],
  };

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Create the pull record up front so we always have a receipt
  const pullInsert = await db.insert(batchdataPulls).values({
    filterName,
    searchCriteria: JSON.stringify(criteria),
  });
  result.pullId = Number((pullInsert as any)?.[0]?.insertId ?? 0);

  try {
    // 1. Search
    const properties = await searchProperties(criteria);
    result.totalResults = properties.length;

    // 2. For each property: dedupe → skip trace → insert
    let skipTraceCount = 0;
    for (const prop of properties) {
      try {
        if (!prop.address.street || !prop.address.city || !prop.address.state || !prop.address.zip) {
          continue;
        }
        const dup = await alreadyIngested(prop.address.street, prop.address.zip);
        if (dup) {
          result.duplicatesSkipped++;
          continue;
        }

        // Skip trace (budget limited)
        let traced = prop;
        if (skipTraceEnabled && skipTraceCount < maxSkipTraces) {
          try {
            traced = await skipTrace(prop);
            skipTraceCount++;
            if (traced.skipTraceResult?.matchStatus === "match") {
              result.skipTraceMatches++;
              result.estimatedCostCents += 7; // ~$0.07 per match
            }
          } catch (e: any) {
            result.errors.push(`skipTrace: ${e?.message ?? e}`);
          }
        }

        // Classify and insert
        const { leadType } = classifyLeadType(traced);
        const phone = traced.skipTraceResult?.phones?.[0]?.number ?? null;
        const email = traced.skipTraceResult?.emails?.[0]?.email ?? null;
        const auctionDate = traced.foreclosure?.auctionDate ? new Date(traced.foreclosure.auctionDate) : null;
        const daysToAuction = auctionDate
          ? Math.ceil((auctionDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : null;

        // Urgent flag (same logic as existing /api/leads/ingest)
        const equityPct = traced.valuation?.equityPercent ?? null;
        const estVal = traced.valuation?.estimatedValue ?? null;
        const equityDollars = equityPct != null && estVal != null ? (equityPct / 100) * estVal : null;
        const isUrgent =
          (equityDollars !== null && equityDollars > 40000) ||
          (daysToAuction !== null && daysToAuction <= 30);

        await insertLead({
          address: traced.address.street,
          city: traced.address.city,
          state: traced.address.state,
          zip: traced.address.zip,
          price: estVal,
          equity: equityPct !== null ? String(equityPct) : null,
          estimatedValue: estVal,
          mortgageBalance: traced.valuation?.mortgageBalance ?? null,
          yearBuilt: traced.building?.yearBuilt ?? null,
          sqft: traced.building?.totalBuildingAreaSquareFeet ?? null,
          bedrooms: traced.building?.bedroomCount ?? null,
          bathrooms:
            traced.building?.bathroomCount != null
              ? String(traced.building.bathroomCount)
              : null,
          leadType: leadType as any,
          source: "BatchData",
          pipelineStage: "new_lead",
          isUrgent,
          auctionDate,
          daysToAuction,
          ownerName: traced.owner?.fullName ?? null,
          ownerPhone: phone,
          ownerEmail: email,
          ownerMailingAddress: traced.owner?.mailingAddress ?? null,
          skipTraceStatus:
            traced.skipTraceResult?.matchStatus === "match"
              ? "complete"
              : traced.skipTraceResult?.matchStatus === "no_match"
              ? "failed"
              : "none",
          rawData: JSON.stringify(traced._raw ?? traced),
        });
        result.newLeadsCreated++;
      } catch (perRowErr: any) {
        result.errors.push(`row: ${perRowErr?.message ?? perRowErr}`);
      }
    }
  } catch (e: any) {
    result.errors.push(`fatal: ${e?.message ?? e}`);
  }

  // Update the pull record with outcomes
  try {
    await db.update(batchdataPulls).set({
      totalResults: result.totalResults,
      newLeadsCreated: result.newLeadsCreated,
      duplicatesSkipped: result.duplicatesSkipped,
      skipTraceMatches: result.skipTraceMatches,
      costCents: result.estimatedCostCents,
      error: result.errors.length ? result.errors.slice(0, 20).join(" | ") : null,
    }).where(eq(batchdataPulls.id, result.pullId));
  } catch {
    // non-fatal
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-configured filter presets (easy entry points for cron / UI)
// ────────────────────────────────────────────────────────────────────────────

export const FILTER_PRESETS: Record<string, PropertySearchCriteria> = {
  al_preforeclosure_high_equity: {
    state: "AL",
    preForeclosure: true,
    minEquityPercent: 40,
    take: 200,
  },
  al_tax_delinquent_high_equity: {
    state: "AL",
    taxDelinquent: true,
    minEquityPercent: 40,
    take: 200,
  },
  al_absentee_high_equity: {
    state: "AL",
    absenteeOwner: true,
    minEquityPercent: 50,
    minValue: 75000,
    take: 200,
  },
  al_vacant: {
    state: "AL",
    vacant: true,
    take: 150,
  },
};

export async function runPreset(presetName: keyof typeof FILTER_PRESETS) {
  const criteria = FILTER_PRESETS[presetName];
  if (!criteria) throw new Error(`Unknown preset: ${String(presetName)}`);
  return runPullJob(String(presetName), criteria);
}
