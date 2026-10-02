ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "target_audience" varchar(50) DEFAULT 'all';--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "image_url" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "id_type" varchar(100);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "id_document_url" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "id_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "id_mime_type" varchar(100);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "id_uploaded_at" timestamp;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "kyc_status" varchar(50) DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "kyc_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "training_site_id" varchar(100);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "financially_able_to_convey" varchar(10);