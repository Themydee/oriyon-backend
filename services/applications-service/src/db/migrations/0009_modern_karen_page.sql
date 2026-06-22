DO $$ BEGIN
 CREATE TYPE "public"."payment_status" AS ENUM('pending', 'success', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cooperative_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(10) DEFAULT 'NGN' NOT NULL,
	"reference" varchar(100) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cooperative_payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "cooperatives" ADD COLUMN "whatsapp_link" varchar(255);--> statement-breakpoint
ALTER TABLE "cooperatives" ADD COLUMN "registration_fee" integer DEFAULT 2000;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cooperative_payments" ADD CONSTRAINT "cooperative_payments_member_id_cooperative_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."cooperative_members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
