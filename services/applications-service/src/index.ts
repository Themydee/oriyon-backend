import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ } from "./rabbitmq";
import applicationsRouter, { runAutoShortlistCheck } from "./routes/applications";
import cooperativeRouter, { runCooperativeMemberIdBackfill } from "./routes/cooperative";
import complaintsRouter from "./routes/complaints";
const app = express();
const PORT = process.env.PORT || 3004;

const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

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
    `);
    console.log("[applications-service] Database columns and performance indexes verified successfully.");
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
