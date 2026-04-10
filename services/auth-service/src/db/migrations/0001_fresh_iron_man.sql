CREATE TABLE IF NOT EXISTS "setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "setup_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "auth_users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_users" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
