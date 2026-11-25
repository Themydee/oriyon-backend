DO $$ BEGIN
  CREATE TYPE "report_status" AS ENUM('draft', 'submitted');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "trainer_lesson_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trainer_id" uuid NOT NULL,
  "trainer_name" varchar(255),
  "trainer_email" varchar(255),
  "cohort_id" uuid NOT NULL,
  "cohort_name" varchar(255),
  "group_id" varchar(128),
  "group_name" varchar(255),
  "session_id" uuid,
  "lesson_id" uuid,
  "week_number" integer,
  "session_title" varchar(255) NOT NULL,
  "date_conducted" timestamp NOT NULL,
  "topics_covered" text NOT NULL,
  "activities" text NOT NULL,
  "trainees_present" integer NOT NULL DEFAULT 0,
  "learning_outcomes" text NOT NULL,
  "challenges" text,
  "comments" text,
  "attachment_url" text,
  "attachment_name" varchar(255),
  "status" "report_status" NOT NULL DEFAULT 'draft',
  "is_delivered" boolean NOT NULL DEFAULT false,
  "delivered_at" timestamp,
  "submitted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_trainer_reports_trainer" ON "trainer_lesson_reports" ("trainer_id");
CREATE INDEX IF NOT EXISTS "idx_trainer_reports_cohort" ON "trainer_lesson_reports" ("cohort_id");
CREATE INDEX IF NOT EXISTS "idx_trainer_reports_group" ON "trainer_lesson_reports" ("group_id");
CREATE INDEX IF NOT EXISTS "idx_trainer_reports_status" ON "trainer_lesson_reports" ("status");
