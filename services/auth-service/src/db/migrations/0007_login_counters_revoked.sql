ALTER TABLE "auth_users" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_attempt_counters" (
	"email" varchar(255) PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_start" timestamp NOT NULL
);
