ALTER TYPE "application_status" ADD VALUE 'rejection_review';--> statement-breakpoint
ALTER TYPE "application_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_deleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "deleted_at" timestamp;