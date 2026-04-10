CREATE TABLE `leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`address` varchar(255) NOT NULL,
	`city` varchar(100) NOT NULL,
	`state` varchar(50) NOT NULL,
	`zip` varchar(20) NOT NULL,
	`price` int,
	`equity` decimal(5,2),
	`leadType` enum('preforeclosure','absentee','vacant') NOT NULL,
	`source` enum('Propwire','PropStream') NOT NULL,
	`status` enum('new','contacted','qualified','closed') NOT NULL DEFAULT 'new',
	`notes` text,
	`rawData` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
