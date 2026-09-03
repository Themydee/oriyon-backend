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
  quizzesRouter,
  examsRouter,
  week12Router,
  tutorialsRouter,
  practicalRouter,
} from "./routes/lms";
import statsRouter from "./routes/stats";
import communityRouter from "./routes/community";
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
app.use("/lms/quizzes", quizzesRouter);
app.use("/lms/exams", examsRouter);
app.use("/lms/week12", week12Router);
app.use("/lms/tutorials", tutorialsRouter);
app.use("/lms/practical", practicalRouter);
app.use("/lms/community", communityRouter);
app.use("/api/lms/quizzes", quizzesRouter);
app.use("/api/lms/exams", examsRouter);
app.use("/api/lms/week12", week12Router);
app.use("/api/lms/weeks", weeksRouter);    
app.use("/api/lms/lessons", lessonsRouter); 
app.use("/api/lms/progress", progressRouter); 
app.use("/api/lms/sessions", sessionsRouter); 
app.use("/api/lms/stats", statsRouter);    
app.use("/api/lms/tutorials", tutorialsRouter);    
app.use("/api/lms/practical", practicalRouter);    
app.use("/api/lms/community", communityRouter);    

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

async function ensureDbColumns() {
  try {
    await queryClient.unsafe(`
      ALTER TABLE lessons ADD COLUMN IF NOT EXISTS audio_url text;
      
      CREATE TABLE IF NOT EXISTS practical_checkins (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        cohort_id uuid NOT NULL,
        group_id varchar(128),
        week_number integer NOT NULL,
        code_submitted varchar(128) NOT NULL,
        verified_by uuid,
        checked_in_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS community_questions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        content text NOT NULL,
        author_id uuid NOT NULL,
        author_name varchar(255) NOT NULL,
        author_role varchar(50) NOT NULL DEFAULT 'trainee',
        author_avatar text,
        channel_id varchar(100) NOT NULL DEFAULT 'general',
        channel_name varchar(255) NOT NULL DEFAULT 'General Discussion',
        tags jsonb DEFAULT '[]'::jsonb,
        upvotes integer NOT NULL DEFAULT 0,
        upvoted_by jsonb DEFAULT '[]'::jsonb,
        is_solved boolean NOT NULL DEFAULT false,
        solved_answer_id uuid,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS community_answers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        question_id uuid NOT NULL REFERENCES community_questions(id) ON DELETE CASCADE,
        content text NOT NULL,
        author_id uuid NOT NULL,
        author_name varchar(255) NOT NULL,
        author_role varchar(50) NOT NULL DEFAULT 'trainee',
        author_avatar text,
        is_verified boolean NOT NULL DEFAULT false,
        upvotes integer NOT NULL DEFAULT 0,
        upvoted_by jsonb DEFAULT '[]'::jsonb,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS community_replies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        answer_id uuid NOT NULL REFERENCES community_answers(id) ON DELETE CASCADE,
        content text NOT NULL,
        author_id uuid NOT NULL,
        author_name varchar(255) NOT NULL,
        author_role varchar(50) NOT NULL DEFAULT 'trainee',
        author_avatar text,
        created_at timestamp NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS community_chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id varchar(100) NOT NULL DEFAULT 'general',
        text text NOT NULL,
        author_id uuid NOT NULL,
        author_name varchar(255) NOT NULL,
        author_role varchar(50) NOT NULL DEFAULT 'trainee',
        author_avatar text,
        is_pinned boolean DEFAULT false,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    console.log("[lms-service] Auto-migration: ensured community tables & columns exist.");
  } catch (err) {
    console.error("[lms-service] Failed to ensure DB schema:", err);
  }
}

async function bootstrap() {
  await ensureDbColumns();
  await connectRabbitMQ(process.env.RABBITMQ_URL!);
  await setupConsumers();
  app.listen(PORT, () => {
    console.log(`[lms-service] Running on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
