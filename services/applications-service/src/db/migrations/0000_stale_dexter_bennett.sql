DO $$ BEGIN
 CREATE TYPE "public"."application_status" AS ENUM('pending', 'shortlisted', 'approved', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"state" varchar(100),
	"gender" varchar(20),
	"age_range" varchar(20),
	"occupation" varchar(100),
	"livestock_experience" text,
	"motivation" text,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"cohort_id" uuid,
	"reviewed_by" uuid,
	"review_notes" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
