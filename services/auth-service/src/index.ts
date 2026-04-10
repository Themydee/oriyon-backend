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

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

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

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);

  // Register RabbitMQ listeners
  await subscribeToEvent("user.created", handleUserCreated);

  app.listen(PORT, () => {
    console.log(`[auth-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);