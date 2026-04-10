// ─────────────────────────────────────────────
// ROUTING KEYS (single source of truth)
// ─────────────────────────────────────────────
export const EVENTS = {
  USER_CREATED: "user.created",
  USER_ENROLLED: "user.enrolled",
  USER_LOGGED_IN: "user.logged_in",
  APPLICATION_SUBMITTED: "application.submitted",
  APPLICATION_APPROVED: "application.approved",
  APPLICATION_REJECTED: "application.rejected",
  LESSON_COMPLETED: "lesson.completed",
  WEEK_COMPLETED: "week.completed",
  COHORT_COMPLETED: "cohort.completed",
} as const;

export type EventKey = (typeof EVENTS)[keyof typeof EVENTS];

// ─────────────────────────────────────────────
// USER EVENTS
// ─────────────────────────────────────────────
export interface UserCreatedPayload {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "trainee" | "trainer" | "admin";
  cohortId?: string;
}

export interface UserEnrolledPayload {
  userId: string;
  cohortId: string;
  enrolledAt: string;
}

export interface UserLoggedInPayload {
  userId: string;
  email: string;
  timestamp: string;
}

// ─────────────────────────────────────────────
// APPLICATION EVENTS
// ─────────────────────────────────────────────
export interface ApplicationSubmittedPayload {
  applicationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  submittedAt: string;
}

export interface ApplicationApprovedPayload {
  applicationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  cohortId: string;
  temporaryPassword: string;
}

export interface ApplicationRejectedPayload {
  applicationId: string;
  email: string;
  firstName: string;
}

// ─────────────────────────────────────────────
// LMS EVENTS
// ─────────────────────────────────────────────
export interface LessonCompletedPayload {
  userId: string;
  lessonId: string;
  lessonTitle: string;
  weekId: string;
  cohortId: string;
  completedAt: string;
}

export interface WeekCompletedPayload {
  userId: string;
  weekId: string;
  weekTitle: string;
  cohortId: string;
  completedAt: string;
}

export interface CohortCompletedPayload {
  userId: string;
  cohortId: string;
  cohortName: string;
  completedAt: string;
}

// ─────────────────────────────────────────────
// SHARED DB TYPES
// ─────────────────────────────────────────────
export type UserRole = "trainee" | "trainer" | "admin";
export type ApplicationStatus = "pending" | "shortlisted" | "approved" | "rejected";
export type LessonType = "video" | "document" | "quiz";
export type SessionType = "online" | "physical";
