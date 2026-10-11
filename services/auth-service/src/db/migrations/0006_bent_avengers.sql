CREATE TABLE IF NOT EXISTS "login_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" varchar(30) NOT NULL,
	"success" boolean NOT NULL,
	"reason" varchar(50) NOT NULL,
	"email" varchar(255),
	"user_id" uuid,
	"role" varchar(50),
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_events_created_at_idx" ON "login_events" USING btree ("created_at");