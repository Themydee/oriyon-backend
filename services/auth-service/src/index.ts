import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ, subscribeToEvent } from "./rabbitmq";
import authRouter from "./routes/auth";
import { handleUserCreated } from "./listeners/userCreated.listener";
import { handleUserDeactivated } from "./listeners/userDeactivated.listener";
import { handleUserUpdated } from "./listeners/userUpdated.listener";

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

queryClient`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role') THEN
      BEGIN
        ALTER TYPE role ADD VALUE IF NOT EXISTS 'sub_admin';
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      BEGIN
        ALTER TYPE role ADD VALUE IF NOT EXISTS 'cooperative';
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      BEGIN
        ALTER TYPE role ADD VALUE IF NOT EXISTS 'state_coordinator';
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      BEGIN
        ALTER TYPE role ADD VALUE IF NOT EXISTS 'zonal_coordinator';
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      BEGIN
        ALTER TYPE role ADD VALUE IF NOT EXISTS 'lga_coordinator';
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;

    BEGIN
      ALTER TABLE auth_users ALTER COLUMN role TYPE varchar(50) USING role::text;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END $$;
`.catch((err: any) =>
  console.error("[auth-service] Role migration warning:", err)
);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "auth-service" });
});

app.use("/auth", authRouter);
app.use("/api/auth", authRouter);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);

  // Register RabbitMQ listeners
  await subscribeToEvent("user.created", handleUserCreated);
  await subscribeToEvent("user.deactivated", handleUserDeactivated);
  await subscribeToEvent("user.updated", handleUserUpdated);

  app.listen(PORT, () => {
    console.log(`[auth-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);