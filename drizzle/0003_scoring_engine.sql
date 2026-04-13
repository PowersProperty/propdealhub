-- Phase 1: 4-Dimension Scoring Engine
-- Adds 6 new columns to `leads` for the motivation / economics / urgency / reachability breakdown
-- Note: `dealScore` already exists from 0002_propdealhub_v2.sql, so it is NOT re-added here
-- Safe to apply via Railway DB query console. Idempotent is NOT guaranteed — run once.

ALTER TABLE `leads`
  ADD COLUMN `motivationScore` FLOAT NULL AFTER `dealScore`,
  ADD COLUMN `economicsScore` FLOAT NULL AFTER `motivationScore`,
  ADD COLUMN `urgencyScore` FLOAT NULL AFTER `economicsScore`,
  ADD COLUMN `reachabilityScore` FLOAT NULL AFTER `urgencyScore`,
  ADD COLUMN `lastScoredAt` TIMESTAMP NULL AFTER `reachabilityScore`,
  ADD COLUMN `distressFlags` VARCHAR(255) NULL AFTER `lastScoredAt`;
