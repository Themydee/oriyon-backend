ALTER TABLE "cooperative_members" ADD COLUMN "location_id" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperative_members" ADD COLUMN "region_id" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperatives" ADD COLUMN "location_id" varchar(100);--> statement-breakpoint
ALTER TABLE "cooperatives" ADD COLUMN "region_id" varchar(100);