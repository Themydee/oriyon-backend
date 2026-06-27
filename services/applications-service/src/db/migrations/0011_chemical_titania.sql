CREATE TABLE IF NOT EXISTS "complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracking_code" varchar(50) NOT NULL,
	"name" varchar(150) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"nature_of_complaint" varchar(150) NOT NULL,
	"date_of_incident" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"evidence" text,
	"evidence_filename" varchar(255),
	"evidence_mime_type" varchar(100),
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_tracking_code_unique" UNIQUE("tracking_code")
);
