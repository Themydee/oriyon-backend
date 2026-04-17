ALTER TABLE "exams"
  ADD COLUMN IF NOT EXISTS "week_id" uuid;

DO $$ BEGIN
  ALTER TABLE "exams"
    ADD CONSTRAINT "exams_week_id_weeks_id_fk"
    FOREIGN KEY ("week_id")
    REFERENCES "public"."weeks"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
