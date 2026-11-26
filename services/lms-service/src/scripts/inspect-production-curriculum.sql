-- READ-ONLY PRODUCTION INSPECTION QUERIES FOR MASTER CURRICULUM PHASE 1
-- Run against lms_db (and user_db for cohort names) BEFORE any backfill.

-- 1. Cohort-level week summary in lms_db
SELECT
    cohort_id,
    COUNT(*) AS total_weeks,
    COUNT(DISTINCT week_number) AS distinct_weeks,
    COUNT(*) FILTER (WHERE is_published = true) AS published_weeks
FROM weeks
GROUP BY cohort_id
ORDER BY cohort_id;

-- 2. Detailed week-by-week records with lesson, quiz, progress, and quiz_attempt counts
SELECT
    w.cohort_id,
    w.id AS week_id,
    w.week_number,
    w.title,
    w.is_published,
    w.unlock_date,
    (SELECT COUNT(*) FROM lessons l WHERE l.week_id = w.id) AS lessons_count,
    (SELECT COUNT(*) FROM quizzes q WHERE q.week_id = w.id) AS quizzes_count,
    (SELECT COUNT(*) FROM progress p WHERE p.week_id = w.id) AS progress_refs,
    (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.week_id = w.id) AS quiz_attempt_refs
FROM weeks w
ORDER BY w.cohort_id, w.week_number, w.created_at;

-- 3. Check for duplicate week_numbers within the same cohort
SELECT cohort_id, week_number, COUNT(*) AS row_count
FROM weeks
GROUP BY cohort_id, week_number
HAVING COUNT(*) > 1
ORDER BY cohort_id, week_number;

-- 4. Check quizzes and their attempt counts
SELECT
    q.cohort_id,
    q.id AS quiz_id,
    q.week_id,
    w.week_number,
    q.title,
    q.is_published,
    q.passing_score,
    (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) AS attempt_count
FROM quizzes q
LEFT JOIN weeks w ON w.id = q.week_id
ORDER BY q.cohort_id, w.week_number, q.created_at;
