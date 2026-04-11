import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ } from "./rabbitmq";
import applicationsRouter from "./routes/applications";

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
app.use("/api/applications", applicationsRouter); // add this

async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  app.listen(PORT, () => {
    console.log(`[applications-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
