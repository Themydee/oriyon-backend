CREATE TABLE IF NOT EXISTS "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"subscribed_at" timestamp DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp,
	CONSTRAINT "subscribers_email_unique" UNIQUE("email")
);
