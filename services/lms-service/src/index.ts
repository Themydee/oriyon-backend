import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { connectRabbitMQ, consumeEvent } from "./rabbitmq";
import {
  weeksRouter,
  lessonsRouter,
  progressRouter,
  sessionsRouter,
} from "./routes/lms";
import statsRouter from "./routes/stats";
import { progress, lessons, weeks } from "./db/schema";
import { eq } from "drizzle-orm";

const app = express();
const PORT = process.env.PORT || 3003;

const queryClient = postgres(process.env.DATABASE_URL!);
export const db = drizzle(queryClient);

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "lms-service" });
});

app.use("/lms/weeks", weeksRouter);
app.use("/lms/lessons", lessonsRouter);
app.use("/lms/progress", progressRouter);
app.use("/lms/sessions", sessionsRouter);
app.use("/lms/stats", statsRouter);

async function setupConsumers() {
  // When a user is enrolled → seed empty progress records for all published lessons in that cohort
  await consumeEvent(
    "user.enrolled",
    "lms-service.user.enrolled",
    async (payload) => {
      const { userId, cohortId } = payload as any;

      const cohortWeeks = await db.select().from(weeks).where(eq(weeks.cohortId, cohortId));

      for (const week of cohortWeeks) {
        const weekLessons = await db.select().from(lessons).where(eq(lessons.weekId, week.id));
        for (const lesson of weekLessons) {
          await db
            .insert(progress)
            .values({ userId, lessonId: lesson.id, weekId: week.id, cohortId, completed: false })
            .onConflictDoNothing();
        }
      }

      console.log(`[lms-service] Seeded progress records for user ${userId} in cohort ${cohortId}`);
    }
  );
}

async function bootstrap() {
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  await setupConsumers();
  app.listen(PORT, () => {
    console.log(`[lms-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
