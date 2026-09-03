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
app.use(express.json());

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
