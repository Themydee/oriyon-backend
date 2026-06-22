ALTER TYPE "role" ADD VALUE 'coordinator';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "assigned_state" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "assigned_lga" varchar(100);