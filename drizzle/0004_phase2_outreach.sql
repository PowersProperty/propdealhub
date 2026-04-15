-- ════════════════════════════════════════════════════════════════════════════
-- Phase 2 Migration: Automated outreach, compliance, Gmail integration
-- ════════════════════════════════════════════════════════════════════════════
-- Adds the tables required for:
--   • BatchData ingest tracking
--   • DNC / CAN-SPAM suppression list
--   • Gmail OAuth token storage
--   • Outreach review queue (tier 7.5–8.9 manual approval)
--   • Extended outreach_log with template + unsubscribe tracking
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Suppression list (CAN-SPAM + self-managed DNC) ─────────────────────────
CREATE TABLE IF NOT EXISTS `suppression_list` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `contact` VARCHAR(320) NOT NULL,              -- email or E.164 phone
  `contact_type` ENUM('email','phone') NOT NULL,
  `reason` ENUM('unsubscribed','bounced','complained','manual','dnc_list','litigator') NOT NULL,
  `source_lead_id` INT NULL,                    -- optional: which lead triggered this
  `notes` TEXT NULL,
  `suppressed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_contact` (`contact`, `contact_type`),
  INDEX `idx_contact_lookup` (`contact`)
);

-- ─── Gmail OAuth token storage ──────────────────────────────────────────────
-- Single row keyed by gmail address. Refresh token is the long-lived credential.
CREATE TABLE IF NOT EXISTS `gmail_tokens` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `gmail_address` VARCHAR(320) NOT NULL UNIQUE,
  `access_token` TEXT NOT NULL,
  `refresh_token` TEXT NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `scope` TEXT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ─── Outreach review queue (tier 7.5–8.9 = manual approval) ─────────────────
CREATE TABLE IF NOT EXISTS `outreach_queue` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `lead_id` INT NOT NULL,
  `channel` ENUM('email','sms') NOT NULL,
  `template_id` VARCHAR(64) NOT NULL,
  `subject` VARCHAR(500) NULL,
  `rendered_body` TEXT NOT NULL,
  `tier` ENUM('auto','review') NOT NULL,        -- auto = 9.0+, review = 7.5–8.9
  `status` ENUM('pending','approved','rejected','sent','failed','skipped_suppressed') NOT NULL DEFAULT 'pending',
  `scheduled_for` TIMESTAMP NULL,
  `reviewed_by` VARCHAR(320) NULL,
  `reviewed_at` TIMESTAMP NULL,
  `sent_at` TIMESTAMP NULL,
  `unsubscribe_token` VARCHAR(128) NULL,
  `failure_reason` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_status_scheduled` (`status`, `scheduled_for`),
  INDEX `idx_lead` (`lead_id`)
);

-- ─── BatchData pull log (audit + dedupe) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS `batchdata_pulls` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `pulled_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `filter_name` VARCHAR(100) NOT NULL,          -- e.g. "al_preforeclosure_high_equity"
  `search_criteria` TEXT NOT NULL,               -- JSON of the criteria used
  `total_results` INT NOT NULL DEFAULT 0,
  `new_leads_created` INT NOT NULL DEFAULT 0,
  `duplicates_skipped` INT NOT NULL DEFAULT 0,
  `skip_trace_matches` INT NOT NULL DEFAULT 0,
  `cost_cents` INT NOT NULL DEFAULT 0,            -- ~7 cents per skip trace match
  `error` TEXT NULL
);

-- ─── Extend outreach_log with template + unsubscribe tracking ───────────────
-- Using ALTER with existence guards via stored procedure pattern
ALTER TABLE `outreach_log`
  ADD COLUMN IF NOT EXISTS `template_id` VARCHAR(64) NULL AFTER `message`,
  ADD COLUMN IF NOT EXISTS `unsubscribe_token` VARCHAR(128) NULL AFTER `template_id`,
  ADD COLUMN IF NOT EXISTS `gmail_message_id` VARCHAR(255) NULL AFTER `unsubscribe_token`,
  ADD COLUMN IF NOT EXISTS `subject` VARCHAR(500) NULL AFTER `gmail_message_id`;

-- Add unique unsubscribe token index for fast lookups from /api/unsubscribe/:token
CREATE INDEX IF NOT EXISTS `idx_outreach_unsub` ON `outreach_log`(`unsubscribe_token`);

-- ════════════════════════════════════════════════════════════════════════════
-- End Phase 2 migration
-- ════════════════════════════════════════════════════════════════════════════
