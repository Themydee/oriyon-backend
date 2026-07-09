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

async function bootstrap() {
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
