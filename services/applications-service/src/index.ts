import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

import { connectRabbitMQ } from "./rabbitmq";
import applicationsRouter, { runAutoShortlistCheck } from "./routes/applications";
import cooperativeRouter, { runCooperativeMemberIdBackfill } from "./routes/cooperative";
import complaintsRouter from "./routes/complaints";
import workshopsRouter from "./routes/workshops";
const app = express();
const PORT = process.env.PORT || 3004;

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "applications-service" });
});

app.use("/applications", applicationsRouter);
app.use("/api/applications", applicationsRouter); 
app.use("/api/cooperative", cooperativeRouter);
app.use("/complaints", complaintsRouter);
app.use("/api/complaints", complaintsRouter);
app.use("/api/workshops", workshopsRouter);
app.use("/workshops", workshopsRouter);

async function ensureDbColumnsExist() {
  const client = postgres(process.env.DATABASE_URL!);
  try {
    await client.unsafe(`
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS id_type VARCHAR(100);
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS id_document_url TEXT;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS id_filename VARCHAR(255);
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS id_mime_type VARCHAR(100);
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS id_uploaded_at TIMESTAMP;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS approved_role VARCHAR(255);
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS cohort_id UUID;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS reviewed_by UUID;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS review_notes TEXT;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_applications_submitted_at ON applications(submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
      CREATE INDEX IF NOT EXISTS idx_applications_cohort_id ON applications(cohort_id);

      -- EEWYLA Referee Verification System
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS referee_declaration_confirmed BOOLEAN DEFAULT false;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS referee_declaration_timestamp TIMESTAMP;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS referee_verification_status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS referee_verified_at TIMESTAMP;
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS is_eligible_for_review BOOLEAN DEFAULT false;

      CREATE TABLE IF NOT EXISTS application_referees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        referee_index INTEGER NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        normalized_phone VARCHAR(50) NOT NULL,
        email VARCHAR(255),
        relationship VARCHAR(100),
        status VARCHAR(50) NOT NULL DEFAULT 'REF-PENDING',
        status_reason TEXT,
        channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
        delivery_status VARCHAR(50) NOT NULL DEFAULT 'pending',
        delivery_timestamp TIMESTAMP,
        initial_message_sent_at TIMESTAMP,
        first_response_at TIMESTAMP,
        response_duration_seconds INTEGER,
        rapid_response_flagged BOOLEAN NOT NULL DEFAULT false,
        reconfirmation_status VARCHAR(50),
        reconfirmation_sent_at TIMESTAMP,
        relationship_category VARCHAR(100),
        relationship_responded_at TIMESTAMP,
        verification_token VARCHAR(128) UNIQUE,
        token_hash VARCHAR(128),
        token_expires_at TIMESTAMP,
        form_submitted_at TIMESTAMP,
        form_vouch_commitment BOOLEAN,
        form_applicant_interest TEXT,
        form_relationship_duration VARCHAR(100),
        is_opted_out BOOLEAN NOT NULL DEFAULT false,
        opted_out_at TIMESTAMP,
        replacement_window_expires_at TIMESTAMP,
        replaced_by_referee_id UUID,
        clarification_sent BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS referee_verification_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        referee_id UUID REFERENCES application_referees(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        previous_status VARCHAR(50),
        new_status VARCHAR(50),
        reason TEXT,
        metadata JSONB,
        actor VARCHAR(100) NOT NULL DEFAULT 'system',
        timestamp TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS referee_scheduled_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        referee_id UUID REFERENCES application_referees(id) ON DELETE CASCADE,
        job_type VARCHAR(100) NOT NULL,
        scheduled_for TIMESTAMP NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        processed_at TIMESTAMP,
        payload JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_app_referees_app_id ON application_referees(application_id);
      CREATE INDEX IF NOT EXISTS idx_app_referees_norm_phone ON application_referees(normalized_phone);
      CREATE INDEX IF NOT EXISTS idx_app_referees_token ON application_referees(verification_token);
      CREATE INDEX IF NOT EXISTS idx_ref_audit_app_id ON referee_verification_audit_logs(application_id);
      CREATE INDEX IF NOT EXISTS idx_ref_jobs_status_sched ON referee_scheduled_jobs(status, scheduled_for);

      -- EEWYLA Workshop & Payments
      DO $$ BEGIN
        CREATE TYPE workshop_status AS ENUM ('draft', 'published', 'closed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE workshop_registration_status AS ENUM ('incomplete', 'pending_payment', 'paid', 'cancelled', 'expired');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE workshop_payment_status AS ENUM ('unpaid', 'pending', 'success', 'failed', 'refunded');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE workshop_payment_attempt_status AS ENUM ('pending', 'success', 'failed', 'abandoned');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS workshops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(255) NOT NULL UNIQUE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
        member_price INTEGER NOT NULL DEFAULT 500000,
        standard_price INTEGER NOT NULL DEFAULT 7000000,
        status workshop_status NOT NULL DEFAULT 'published',
        registration_availability BOOLEAN NOT NULL DEFAULT true,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        venue VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workshops_slug ON workshops(slug);
      CREATE INDEX IF NOT EXISTS idx_workshops_status ON workshops(status, registration_availability);

      INSERT INTO workshops (
        slug,
        title,
        description,
        currency,
        member_price,
        standard_price,
        status,
        registration_availability,
        venue,
        metadata
      ) VALUES (
        'eewyla-goat-training',
        'EEWYLA Goat Training Workshop',
        'Intensive hands-on practical training on modern goat husbandry, herd health management, breed selection, nutrition, biosecurity, and commercial livestock enterprise for women and youth.',
        'NGN',
        500000,
        7000000,
        'published',
        true,
        'Oriyon Training Facility & Partner Farms',
        '{"cohort": "2026 Cohort 1", "durationDays": 3, "certificateIncluded": true}'::jsonb
      )
      ON CONFLICT (slug) DO UPDATE SET
        title = EXCLUDED.title,
        member_price = EXCLUDED.member_price,
        standard_price = EXCLUDED.standard_price,
        status = EXCLUDED.status,
        registration_availability = EXCLUDED.registration_availability;


      CREATE TABLE IF NOT EXISTS workshop_registrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workshop_id UUID NOT NULL REFERENCES workshops(id) ON DELETE RESTRICT,
        participant_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        email_verified_at TIMESTAMP NOT NULL,
        eligible BOOLEAN NOT NULL,
        eligibility_source VARCHAR(50) NOT NULL,
        eligibility_record_id TEXT,
        eligibility_decision_timestamp TIMESTAMP NOT NULL DEFAULT now(),
        amount INTEGER NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
        status workshop_registration_status NOT NULL DEFAULT 'pending_payment',
        payment_status workshop_payment_status NOT NULL DEFAULT 'unpaid',
        additional_details JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workshop_reg_lookup ON workshop_registrations(workshop_id, email);
      CREATE INDEX IF NOT EXISTS idx_workshop_reg_status ON workshop_registrations(status, payment_status);

      CREATE TABLE IF NOT EXISTS workshop_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        registration_id UUID NOT NULL REFERENCES workshop_registrations(id) ON DELETE CASCADE,
        reference VARCHAR(100) NOT NULL UNIQUE,
        amount INTEGER NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
        status workshop_payment_attempt_status NOT NULL DEFAULT 'pending',
        paystack_transaction_id VARCHAR(100),
        authorization_url TEXT,
        initialized_at TIMESTAMP NOT NULL DEFAULT now(),
        verified_at TIMESTAMP,
        paid_at TIMESTAMP,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workshop_payments_ref ON workshop_payments(reference);

      CREATE TABLE IF NOT EXISTS workshop_email_challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        workshop_slug VARCHAR(255) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        used BOOLEAN NOT NULL DEFAULT false,
        used_at TIMESTAMP,
        ip_address VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workshop_challenge_email ON workshop_email_challenges(email, workshop_slug, used, expires_at);

      CREATE TABLE IF NOT EXISTS workshop_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id VARCHAR(255) NOT NULL UNIQUE,
        event_type VARCHAR(100) NOT NULL,
        reference VARCHAR(100),
        status VARCHAR(50) NOT NULL DEFAULT 'processed',
        payload JSONB NOT NULL,
        processed_at TIMESTAMP NOT NULL DEFAULT now(),
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_workshop_webhook_events_id ON workshop_webhook_events(event_id);
    `);
    console.log("[applications-service] Database columns, workshop tables, and performance indexes verified successfully.");
  } catch (err) {
    console.error("[applications-service] Migration error:", err);
  } finally {
    await client.end();
  }
}

async function bootstrap() {
  await ensureDbColumnsExist();
  await connectRabbitMQ(process.env.RABBITMQ_URL!);

  // Run backfill for existing cooperative members missing IDs
  runCooperativeMemberIdBackfill().catch(err => {
    console.error("[Cooperative ID Backfill Error]:", err);
  });

  // Run auto-shortlist check once on startup, then every 10 minutes
  runAutoShortlistCheck().catch(err => {
    console.error("[Auto-Shortlist Startup Error]:", err);
  });

  const TEN_MINUTES = 10 * 60 * 1000;
  setInterval(() => {
    runAutoShortlistCheck().catch(err => {
      console.error("[Auto-Shortlist Scheduler Error]:", err);
    });
  }, TEN_MINUTES);

  app.listen(PORT, () => {
    console.log(`[applications-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
