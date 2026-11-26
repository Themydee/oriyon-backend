-- Phase 1: Additive Master Curriculum & Cohort Versioning Schema (Non-Destructive)
-- Safe to run multiple times (idempotent); preserves all existing tables, columns, and rows.

CREATE TABLE IF NOT EXISTS master_curricula (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64) NOT NULL UNIQUE,
  title varchar(255) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS curriculum_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id uuid NOT NULL REFERENCES master_curricula(id) ON DELETE RESTRICT,
  version_label varchar(32) NOT NULL,
  version_number integer NOT NULL,
  change_classification varchar(32) NOT NULL DEFAULT 'initial',
  status varchar(32) NOT NULL DEFAULT 'draft',
  summary text,
  effective_from timestamp,
  published_by uuid,
  published_at timestamp,
  parent_revision_id uuid,
  created_by uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_curriculum_revision_version ON curriculum_revisions (curriculum_id, version_number);
CREATE INDEX IF NOT EXISTS idx_curriculum_revision_status ON curriculum_revisions (status);

CREATE TABLE IF NOT EXISTS curriculum_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES curriculum_revisions(id) ON DELETE RESTRICT,
  title varchar(255) NOT NULL,
  description text,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_curriculum_modules_rev ON curriculum_modules (revision_id);

CREATE TABLE IF NOT EXISTS cohort_curriculum_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  cohort_name varchar(255),
  revision_id uuid NOT NULL REFERENCES curriculum_revisions(id) ON DELETE RESTRICT,
  is_pinned boolean NOT NULL DEFAULT true,
  bound_by uuid,
  bound_at timestamp NOT NULL DEFAULT now(),
  previous_revision_id uuid,
  upgrade_reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cohort_curriculum_binding ON cohort_curriculum_bindings (cohort_id);
CREATE INDEX IF NOT EXISTS idx_cohort_binding_rev ON cohort_curriculum_bindings (revision_id);

CREATE TABLE IF NOT EXISTS cohort_week_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  week_number integer NOT NULL,
  master_week_id uuid,
  unlock_date timestamp,
  practical_required boolean NOT NULL DEFAULT true,
  quiz_required boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cohort_week_schedule ON cohort_week_schedules (cohort_id, week_number);
CREATE INDEX IF NOT EXISTS idx_cohort_week_schedule_cohort ON cohort_week_schedules (cohort_id);

CREATE TABLE IF NOT EXISTS curriculum_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id uuid,
  revision_id uuid,
  cohort_id uuid,
  action varchar(64) NOT NULL,
  change_classification varchar(32),
  actor_id uuid,
  actor_role varchar(64),
  reason text,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_curriculum_audit_rev ON curriculum_audit_logs (revision_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_audit_cohort ON curriculum_audit_logs (cohort_id);

-- Additive nullable columns on existing tables (preserving cohort_id and historical records)
ALTER TABLE weeks ADD COLUMN IF NOT EXISTS curriculum_revision_id uuid;
ALTER TABLE weeks ADD COLUMN IF NOT EXISTS module_id uuid;
ALTER TABLE weeks ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS curriculum_revision_id uuid;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS curriculum_revision_id uuid;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE progress ADD COLUMN IF NOT EXISTS curriculum_revision_id uuid;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS curriculum_revision_id uuid;
