/**
 * PropDealHub Deal Scoring Engine
 *
 * Pure function that scores leads across four dimensions:
 *   - Motivation  (0-30)  Why would the owner sell below market?
 *   - Economics   (0-30)  Is there actually a deal here?
 *   - Urgency     (0-20)  How fast do we need to act?
 *   - Reachability (0-20) Can we actually contact the owner?
 *
 * Total: 0-100 raw, normalized to 0.0-10.0 for display.
 *
 * Score is recalculated on:
 *   - Lead ingest
 *   - Lead update (skip trace completion, owner data changes, etc.)
 *   - Daily cron (time-based: daysToAuction decay, lead age decay)
 */

export type LeadType =
  | "preforeclosure"
  | "absentee"
  | "vacant"
  | "taxdelinquent"
  | "otc_tax_lien"
  | "pricedrop";

export interface ScoringInput {
  leadType: LeadType;
  distressFlags?: string | null; // comma-separated: "vacant,taxdelinquent"

  // Economics inputs
  equity: number | null;           // percent 0-100
  price: number | null;
  estimatedValue: number | null;
  mortgageBalance: number | null;

  // Urgency inputs
  auctionDate: Date | null;
  daysToAuction: number | null;
  createdAt: Date | null;          // for lead age decay
  pipelineStage?: string | null;   // skip decay for contacted leads

  // Reachability inputs
  skipTraceStatus: "none" | "pending" | "complete" | "failed" | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  ownerMailingAddress: string | null;
}

export interface ScoreBreakdown {
  motivationScore: number;      // 0-30
  economicsScore: number;       // 0-30
  urgencyScore: number;         // 0-20
  reachabilityScore: number;    // 0-20
  totalRaw: number;             // 0-100
  dealScore: number;            // 0-10 (normalized, rounded to 1 decimal)
  isUrgent: boolean;
  reasoning: string[];          // human-readable explanation for each contribution
}

// ──────────────────────────────────────────────────────────────────────────
// Dimension 1: Motivation (0-30)
// ──────────────────────────────────────────────────────────────────────────
function calculateMotivation(input: ScoringInput): { score: number; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  // Base weight from lead type (0-10)
  const typeWeights: Record<LeadType, number> = {
    preforeclosure: 10,
    otc_tax_lien: 10,
    taxdelinquent: 8,
    vacant: 6,
    absentee: 6,
    pricedrop: 4,
  };

  const baseWeight = typeWeights[input.leadType] ?? 0;
  score += baseWeight;
  reasoning.push(`+${baseWeight} lead type: ${input.leadType}`);

  // Stacking bonus: rewards compounding distress signals (0-15)
  if (input.distressFlags) {
    const flags = input.distressFlags.split(",").map(f => f.trim()).filter(Boolean);
    const distinctFlags = new Set(flags).size;
    if (distinctFlags >= 4) {
      score += 15;
      reasoning.push(`+15 stacking bonus (${distinctFlags} flags: ${flags.join(", ")})`);
    } else if (distinctFlags >= 3) {
      score += 10;
      reasoning.push(`+10 stacking bonus (${distinctFlags} flags: ${flags.join(", ")})`);
    } else if (distinctFlags >= 2) {
      score += 5;
      reasoning.push(`+5 stacking bonus (${distinctFlags} flags: ${flags.join(", ")})`);
    }
  }

  // Forced timeline bonus (0-5): preforeclosure or tax lien WITH a set auction date
  // means the owner is on a countdown clock — maximum motivation
  const isForcedTimeline =
    (input.leadType === "preforeclosure" || input.leadType === "otc_tax_lien") &&
    input.auctionDate !== null;
  if (isForcedTimeline) {
    score += 5;
    reasoning.push(`+5 forced timeline (distressed type with auction date)`);
  }

  // Cap at 30
  const capped = Math.min(30, Math.max(0, score));
  if (capped !== score) {
    reasoning.push(`  (capped at 30 from ${score})`);
  }
  return { score: capped, reasoning };
}

// ──────────────────────────────────────────────────────────────────────────
// Dimension 2: Economics (0-30)
// ──────────────────────────────────────────────────────────────────────────
function calculateEconomics(input: ScoringInput): { score: number; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  // Equity tier (0-12)
  if (input.equity !== null) {
    if (input.equity >= 60) {
      score += 12;
      reasoning.push(`+12 equity >= 60% (${input.equity.toFixed(1)}%)`);
    } else if (input.equity >= 40) {
      score += 8;
      reasoning.push(`+8 equity 40-59% (${input.equity.toFixed(1)}%)`);
    } else if (input.equity >= 25) {
      score += 4;
      reasoning.push(`+4 equity 25-39% (${input.equity.toFixed(1)}%)`);
    } else {
      reasoning.push(`+0 equity < 25% (${input.equity.toFixed(1)}%)`);
    }
  } else {
    reasoning.push(`+0 equity unknown`);
  }

  // 70% rule profit margin (0-12)
  // MaxOfferPrice = estimatedValue * 0.7
  // ProfitMargin = MaxOfferPrice - currentPrice
  if (input.estimatedValue !== null && input.price !== null) {
    const maxOffer = input.estimatedValue * 0.7;
    const margin = maxOffer - input.price;
    if (margin >= 40000) {
      score += 12;
      reasoning.push(`+12 70% rule margin >= $40k ($${margin.toFixed(0)})`);
    } else if (margin >= 25000) {
      score += 8;
      reasoning.push(`+8 70% rule margin >= $25k ($${margin.toFixed(0)})`);
    } else if (margin >= 15000) {
      score += 5;
      reasoning.push(`+5 70% rule margin >= $15k ($${margin.toFixed(0)})`);
    } else if (margin >= 5000) {
      score += 2;
      reasoning.push(`+2 70% rule margin >= $5k ($${margin.toFixed(0)})`);
    } else {
      reasoning.push(`+0 70% rule margin thin ($${margin.toFixed(0)})`);
    }
  }

  // Price-to-value ratio (0-6) — only if we have both price and estimatedValue
  if (input.estimatedValue !== null && input.price !== null && input.estimatedValue > 0) {
    const ratio = input.price / input.estimatedValue;
    if (ratio < 0.5) {
      score += 6;
      reasoning.push(`+6 price/value ratio < 50% (${(ratio * 100).toFixed(0)}%)`);
    } else if (ratio < 0.65) {
      score += 4;
      reasoning.push(`+4 price/value ratio 50-65% (${(ratio * 100).toFixed(0)}%)`);
    } else if (ratio < 0.8) {
      score += 2;
      reasoning.push(`+2 price/value ratio 65-80% (${(ratio * 100).toFixed(0)}%)`);
    } else {
      reasoning.push(`+0 price/value ratio > 80% (${(ratio * 100).toFixed(0)}%)`);
    }
  }

  return { score: Math.min(30, Math.max(0, score)), reasoning };
}

// ─────────────────────────────────────────────────────────────────────────
// Dimension 3: Urgency (0-20)
// ──────────────────────────────────────────────────────────────────────────
function calculateUrgency(input: ScoringInput): { score: number; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  // Auction proximity
  if (input.daysToAuction !== null) {
    if (input.daysToAuction <= 0) {
      // Auction passed — this is a dead/stale lead
      score += 0;
      reasoning.push(`+0 auction passed (${input.daysToAuction} days)`);
    } else if (input.daysToAuction <= 7) {
      score += 20;
      reasoning.push(`+20 auction in ${input.daysToAuction} days (CRITICAL)`);
    } else if (input.daysToAuction <= 14) {
      score += 15;
      reasoning.push(`+15 auction in ${input.daysToAuction} days`);
    } else if (input.daysToAuction <= 30) {
      score += 10;
      reasoning.push(`+10 auction in ${input.daysToAuction} days`);
    } else if (input.daysToAuction <= 60) {
      score += 5;
      reasoning.push(`+5 auction in ${input.daysToAuction} days`);
    } else {
      reasoning.push(`+0 auction in ${input.daysToAuction} days (distant)`);
    }
  }

  return { score: Math.min(20, Math.max(0, score)), reasoning };
}

// ──────────────────────────────────────────────────────────────────────────
// Total-score decay: lead age penalty applied against the combined total
// so it affects final score even when urgency is already 0
// ──────────────────────────────────────────────────────────────────────────
function calculateAgeDecay(input: ScoringInput): { penalty: number; reason: string | null } {
  if (!input.createdAt) return { penalty: 0, reason: null };
  // Only decay uncontacted leads — once in conversation, the age penalty stops
  if (input.pipelineStage && input.pipelineStage !== "new_lead") {
    return { penalty: 0, reason: null };
  }
  const ageDays = (Date.now() - input.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 30) {
    return { penalty: 10, reason: `-10 lead age decay (${ageDays.toFixed(0)} days uncontacted)` };
  } else if (ageDays > 14) {
    return { penalty: 5, reason: `-5 lead age decay (${ageDays.toFixed(0)} days uncontacted)` };
  }
  return { penalty: 0, reason: null };
}

// ──────────────────────────────────────────────────────────────────────────
// Dimension 4: Reachability (0-20)
// ──────────────────────────────────────────────────────────────────────────
function calculateReachability(input: ScoringInput): { score: number; reasoning: string[] } {
  const reasoning: string[] = [];
  let score = 0;

  const hasPhone = !!input.ownerPhone && input.ownerPhone.replace(/\D/g, "").length >= 10;
  const hasEmail = !!input.ownerEmail && input.ownerEmail.includes("@");
  const hasMailing = !!input.ownerMailingAddress && input.ownerMailingAddress.length > 5;
  const skipComplete = input.skipTraceStatus === "complete";

  if (skipComplete && hasPhone) {
    score += 15;
    reasoning.push(`+15 skip trace complete with phone`);
  } else if (hasPhone) {
    score += 10;
    reasoning.push(`+10 has phone (skip trace incomplete)`);
  } else if (skipComplete) {
    reasoning.push(`+0 skip trace complete but no phone found`);
  } else {
    reasoning.push(`+0 no phone available`);
  }

  if (hasEmail) {
    score += 3;
    reasoning.push(`+3 has email`);
  }

  if (hasMailing) {
    score += 2;
    reasoning.push(`+2 has mailing address`);
  }

  return { score: Math.min(20, Math.max(0, score)), reasoning };
}

// ──────────────────────────────────────────────────────────────────────────
// Main scoring function
// ──────────────────────────────────────────────────────────────────────────
export function scoreLead(input: ScoringInput): ScoreBreakdown {
  const motivation = calculateMotivation(input);
  const economics = calculateEconomics(input);
  const urgency = calculateUrgency(input);
  const reachability = calculateReachability(input);
  const decay = calculateAgeDecay(input);

  const subtotal =
    motivation.score + economics.score + urgency.score + reachability.score;
  const totalRaw = Math.max(0, subtotal - decay.penalty);

  // Normalize 0-100 to 0.0-10.0
  const dealScore = parseFloat((totalRaw / 10).toFixed(1));

  // Urgency flag: auction within 30 days OR combined score >= 7.5
  const auctionUrgent =
    input.daysToAuction !== null &&
    input.daysToAuction > 0 &&
    input.daysToAuction <= 30;
  const highScoreUrgent = dealScore >= 7.5;
  const isUrgent = auctionUrgent || highScoreUrgent;

  const reasoning = [
    `── Motivation (${motivation.score}/30) ──`,
    ...motivation.reasoning,
    `── Economics (${economics.score}/30) ──`,
    ...economics.reasoning,
    `── Urgency (${urgency.score}/20) ──`,
    ...urgency.reasoning,
    `── Reachability (${reachability.score}/20) ──`,
    ...reachability.reasoning,
    ...(decay.reason ? [`── Age decay ──`, decay.reason] : []),
    `── Total: ${totalRaw}/100 = ${dealScore}/10 ──`,
    isUrgent
      ? `⚡ URGENT (${auctionUrgent ? "auction <= 30d" : "high score"})`
      : `— not flagged urgent`,
  ];

  return {
    motivationScore: motivation.score,
    economicsScore: economics.score,
    urgencyScore: urgency.score,
    reachabilityScore: reachability.score,
    totalRaw,
    dealScore,
    isUrgent,
    reasoning,
  };
}

// ==========================================================================
// Helper: derive distress flags from a lead record
// ==========================================================================
export function deriveDistressFlags(leadType: LeadType, extra?: {
  isVacant?: boolean;
  isAbsentee?: boolean;
  hasTaxLien?: boolean;
  isPreforeclosure?: boolean;
}): string {
  const flags = new Set<string>([leadType]);
  if (extra?.isVacant) flags.add("vacant");
  if (extra?.isAbsentee) flags.add("absentee");
  if (extra?.hasTaxLien) flags.add("taxdelinquent");
  if (extra?.isPreforeclosure) flags.add("preforeclosure");
  return Array.from(flags).join(",");
}

// ==========================================================================
// Helper: compute daysToAuction freshly from an auctionDate
// ==========================================================================
export function computeDaysToAuction(auctionDate: Date | null): number | null {
  if (!auctionDate) return null;
  return Math.ceil(
    (auctionDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
}

