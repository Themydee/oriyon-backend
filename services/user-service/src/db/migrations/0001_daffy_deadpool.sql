ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id_type" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id_document" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id_mime_type" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id_uploaded_at" timestamp;