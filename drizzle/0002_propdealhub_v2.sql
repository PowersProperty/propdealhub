-- PropDealHub v2 migration
-- Adds: new lead columns, pipeline stage, deal score, owner info, outreach_log table

-- 1. Add new columns to leads table
ALTER TABLE `leads`
  ADD COLUMN `estimatedValue` int,
  ADD COLUMN `mortgageBalance` int,
  ADD COLUMN `yearBuilt` int,
  ADD COLUMN `sqft` int,
  ADD COLUMN `bedrooms` int,
  ADD COLUMN `bathrooms` decimal(3,1),
  ADD COLUMN `pipelineStage` enum('new_lead','contacted','conversation_started','appointment_scheduled','property_visit','offer_sent','under_contract','closed','dead') NOT NULL DEFAULT 'new_lead',
  ADD COLUMN `dealScore` float,
  ADD COLUMN `isUrgent` boolean NOT NULL DEFAULT false,
  ADD COLUMN `auctionDate` timestamp,
  ADD COLUMN `daysToAuction` int,
  ADD COLUMN `ownerName` varchar(255),
  ADD COLUMN `ownerPhone` varchar(30),
  ADD COLUMN `ownerEmail` varchar(320),
  ADD COLUMN `ownerMailingAddress` text,
  ADD COLUMN `skipTraceStatus` enum('none','pending','complete','failed') NOT NULL DEFAULT 'none';

-- 2. Modify leadType to include new types
ALTER TABLE `leads`
  MODIFY COLUMN `leadType` enum('preforeclosure','absentee','vacant','taxdelinquent','pricedrop') NOT NULL;

-- 3. Modify source to be a varchar (more flexible)
ALTER TABLE `leads`
  MODIFY COLUMN `source` varchar(100) NOT NULL DEFAULT 'Propwire';

-- 4. Drop old status column (replaced by pipelineStage)
ALTER TABLE `leads`
  DROP COLUMN `status`;

-- 5. Create outreach_log table
CREATE TABLE `outreach_log` (
  `id` int AUTO_INCREMENT NOT NULL,
  `leadId` int NOT NULL,
  `channel` enum('sms','email','telegram','voicemail','direct_mail') NOT NULL,
  `direction` enum('outbound','inbound') NOT NULL DEFAULT 'outbound',
  `message` text NOT NULL,
  `status` enum('sent','delivered','failed','replied') NOT NULL DEFAULT 'sent',
  `sentAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `outreach_log_id` PRIMARY KEY(`id`)
);
