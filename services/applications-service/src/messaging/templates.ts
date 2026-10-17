/**
 * Centralised Message Templates for EEWYLA Automated Referee Verification System
 *
 * Implements templates MSG-01 through MSG-07 with safe variable substitution.
 */

export const RELATIONSHIP_OPTIONS_MAP: Record<string, string> = {
  "1": "Religious Leader",
  "2": "Community Leader / Traditional Ruler",
  "3": "Employer / Business Supervisor",
  "4": "Teacher / Academic Mentor",
  "5": "Family Member / Guardian",
};

export const REVIEW_TURNAROUND_DAYS = "5-7 business days";

export const templates = {
  /**
   * MSG-01: Initial referee ping
   * Sent to both referees after successful application persistence and passing fraud gates.
   */
  msg01(refereeName: string, applicantName: string): string {
    const cleanRef = (refereeName || "Sir/Madam").trim();
    const cleanApp = (applicantName || "the applicant").trim();
    return `Hello ${cleanRef}, ${cleanApp} has applied for the EEWYLA agribusiness training programme by Oriyon International and listed you as a referee. Do you know and vouch for this applicant? Reply YES to confirm or NO to decline. Reply STOP to opt out.`;
  },

  /**
   * MSG-02: Relationship category
   * Sent immediately after a valid YES response to MSG-01.
   */
  msg02(applicantName: string): string {
    const cleanApp = (applicantName || "the applicant").trim();
    return `Thank you for confirming. Please tell us your relationship to ${cleanApp} by replying with the number:\n1: Religious Leader\n2: Community Leader / Traditional Ruler\n3: Employer / Business Supervisor\n4: Teacher / Academic Mentor\n5: Family Member / Guardian`;
  },

  /**
   * Clarification for invalid numeric reply to MSG-02
   */
  msg02Clarification(applicantName: string): string {
    const cleanApp = (applicantName || "the applicant").trim();
    return `Please reply with a number from 1 to 5 to indicate your relationship to ${cleanApp}:\n1: Family/Relative\n2: Community/Religious Leader\n3: Employer/Business Associate\n4: Teacher/Academic Mentor\n5: Other`;
  },

  /**
   * MSG-03: Micro-form escalation
   * Triggered 48 hours after initial verification request if no response.
   */
  msg03(refereeName: string, applicantName: string, formUrl: string): string {
    const cleanRef = (refereeName || "Sir/Madam").trim();
    const cleanApp = (applicantName || "the applicant").trim();
    return `Hello ${cleanRef}, we have not yet received your response regarding ${cleanApp}'s EEWYLA application. Please take 2 minutes to complete this brief verification form: ${formUrl} . Link expires in 72 hours. Reply STOP to opt out.`;
  },

  /**
   * MSG-04: Applicant notification for an unresponsive referee
   * Sent when referee has exhausted initial request and micro-form escalation.
   */
  msg04(applicantName: string, refereeName: string, refereePhone: string, updateUrl: string): string {
    const cleanApp = (applicantName || "Applicant").trim();
    const cleanRef = (refereeName || "Referee").trim();
    return `Dear ${cleanApp}, your referee ${cleanRef} (${refereePhone}) has not responded to our verification requests. To prevent your application from being delayed or deferred, please update your referee details within 5 days using this link: ${updateUrl}`;
  },

  /**
   * MSG-05: Referee declined
   * Sent when a referee declines, including through micro-form Q4 = NO.
   */
  msg05(applicantName: string, refereeName: string, updateUrl: string): string {
    const cleanApp = (applicantName || "Applicant").trim();
    const cleanRef = (refereeName || "Referee").trim();
    return `Dear ${cleanApp}, your referee ${cleanRef} was unable to vouch for your application. Please provide an alternative referee within 5 days to keep your application active: ${updateUrl}`;
  },

  /**
   * MSG-06: Verification complete
   * Sent to applicant once at least one referee is verified and application becomes eligible for review.
   */
  msg06(applicantName: string): string {
    const cleanApp = (applicantName || "Applicant").trim();
    return `Dear ${cleanApp}, your referee verification for the EEWYLA programme is complete! Your application has now entered the review queue. Reviews typically take ${REVIEW_TURNAROUND_DAYS}. You will be notified once a decision has been reached.`;
  },

  /**
   * MSG-07: Rapid-response reconfirmation
   * Sent 24 hours after a flagged affirmative response (< 90s).
   */
  msg07(refereeName: string, applicantName: string): string {
    const cleanRef = (refereeName || "Sir/Madam").trim();
    const cleanApp = (applicantName || "the applicant").trim();
    return `Hello ${cleanRef}, you recently confirmed ${cleanApp} as a referee for the EEWYLA programme. Please reply YES to reconfirm your endorsement, or NO if you wish to withdraw your endorsement.`;
  },
};
