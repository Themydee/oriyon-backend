ALTER TABLE "applications" ADD COLUMN "age" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "has_id" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "business_name" varchar(150);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_coop" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_community_member" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "join_coop" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "education_level" varchar(50);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "field_of_study" varchar(100);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "graduation_year" varchar(20);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "institution" varchar(150);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "has_goat_experience" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "goat_experience_rating" varchar(5);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "owns_goat_farm" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "years_operated" varchar(20);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "highest_animals" varchar(20);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_digitally_literate" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "digital_literacy_rating" varchar(5);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "internet_usage" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "devices" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "online_training" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "platform_experience" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "tool_confidence" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "is_breadwinner" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "has_dependants" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "dependants_detail" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "dependants_school_age" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "has_disabled_in_household" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "disabled_detail" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "benefited_before" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "benefited_detail" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "biggest_challenge" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "why_join" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "hopes_to_achieve" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "willing_traceability" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "has_access" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "willing_champion" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "willing_donate" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "committed_full_training" varchar(10);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "reference1" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "reference2" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "understands_credit" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "declaration_confirmed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "applications" DROP COLUMN IF EXISTS "state";--> statement-breakpoint
ALTER TABLE "applications" DROP COLUMN IF EXISTS "age_range";--> statement-breakpoint
ALTER TABLE "applications" DROP COLUMN IF EXISTS "occupation";--> statement-breakpoint
ALTER TABLE "applications" DROP COLUMN IF EXISTS "livestock_experience";--> statement-breakpoint
ALTER TABLE "applications" DROP COLUMN IF EXISTS "motivation";