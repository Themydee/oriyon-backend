ALTER TABLE "cooperative_members" ALTER COLUMN "first_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cooperative_members" ALTER COLUMN "last_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cooperative_members" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "member_id" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "full_name" varchar(255);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "gender" varchar(20);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "date_of_birth" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "lga" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "zone_cluster" varchar(150);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "occupation" varchar(150);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "years_of_experience" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "id_type" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "id_number" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "next_of_kin_name" varchar(150);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "next_of_kin_phone" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "registration_fee_paid" varchar(10);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "monthly_contribution_amount" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "attendance_commitment" varchar(10);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "qualified_for_training" varchar(10);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "whatsapp_number" varchar(50);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "remarks" text;