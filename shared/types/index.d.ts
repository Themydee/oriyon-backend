export declare const EVENTS: {
    readonly USER_CREATED: "user.created";
    readonly USER_ENROLLED: "user.enrolled";
    readonly USER_LOGGED_IN: "user.logged_in";
    readonly APPLICATION_SUBMITTED: "application.submitted";
    readonly APPLICATION_APPROVED: "application.approved";
    readonly APPLICATION_REJECTED: "application.rejected";
    readonly LESSON_COMPLETED: "lesson.completed";
    readonly WEEK_COMPLETED: "week.completed";
    readonly COHORT_COMPLETED: "cohort.completed";
};
export type EventKey = (typeof EVENTS)[keyof typeof EVENTS];
export interface UserCreatedPayload {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    role: "trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin";
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
export type UserRole = "trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin";
export type ApplicationStatus = "pending" | "shortlisted" | "approved" | "rejected";
export type LessonType = "video" | "document" | "quiz";
export type SessionType = "online" | "physical";
//# sourceMappingURL=index.d.ts.map