CREATE TABLE IF NOT EXISTS "cooperatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"state" varchar(100) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cooperatives_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "cooperative_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cooperative_members" ADD CONSTRAINT "cooperative_members_cooperative_id_cooperatives_id_fk" FOREIGN KEY ("cooperative_id") REFERENCES "public"."cooperatives"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
