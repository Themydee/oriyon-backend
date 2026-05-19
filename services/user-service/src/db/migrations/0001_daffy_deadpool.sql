ALTER TABLE "users" ADD COLUMN "id_type" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_document" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_mime_type" varchar(60);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_uploaded_at" timestamp;