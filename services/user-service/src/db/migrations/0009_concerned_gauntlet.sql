ALTER TABLE "users" ADD COLUMN "kyc_status" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kyc_rejection_reason" text;