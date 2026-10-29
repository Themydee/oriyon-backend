import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ } from "./rabbitmq";
import shopRouter from "./routes/shop";

const app = express();
const PORT = process.env.PORT || 3006;

const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "shop-service" });
});

app.use("/", shopRouter);


async function ensureShopDbColumnsExist() {
  const client = postgres(process.env.DATABASE_URL!);
  try {
    await client.unsafe(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(120);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS paystack_transaction_id VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS metadata JSONB;
      CREATE INDEX IF NOT EXISTS idx_orders_payment_reference ON orders(payment_reference);
    `);
    console.log("[shop-service] Order payment schema columns verified.");
  } catch (err) {
    console.error("[shop-service] Migration check error:", err);
  } finally {
    await client.end();
  }
}

async function bootstrap() {
  await ensureShopDbColumnsExist();
  await connectRabbitMQ(process.env.RABBITMQ_URL!);

  app.listen(PORT, () => {
    console.log(`[shop-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
