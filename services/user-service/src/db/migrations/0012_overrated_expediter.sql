CREATE TABLE IF NOT EXISTS "trainer_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"author_role" varchar(50) NOT NULL,
	"kind" varchar(20) DEFAULT 'reply' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trainer_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reporter_name" varchar(255) NOT NULL,
	"reporter_email" varchar(255) NOT NULL,
	"reporter_phone" varchar(30),
	"cohort_id" uuid,
	"group_id" uuid,
	"group_name" varchar(255),
	"physical_site_id" varchar(100),
	"trainer_id" uuid,
	"trainer_name" varchar(255) NOT NULL,
	"category" varchar(50) NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"subject" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"incident_date" varchar(20),
	"attachment_url" text,
	"attachment_name" varchar(255),
	"status" varchar(30) DEFAULT 'open' NOT NULL,
	"assigned_to_id" uuid,
	"assigned_to_name" varchar(255),
	"first_response_at" timestamp,
	"resolved_at" timestamp,
	"closed_at" timestamp,
	"satisfaction_rating" integer,
	"satisfaction_comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trainer_tickets_code_unique" UNIQUE("code")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trainer_ticket_messages" ADD CONSTRAINT "trainer_ticket_messages_ticket_id_trainer_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."trainer_tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
