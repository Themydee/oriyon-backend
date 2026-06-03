export const swaggerSpec = {
  openapi: "3.0.0",
  info: {
    title: "Oriyon International - Microservices API Gateway",
    version: "1.0.0",
    description: `### Interactive QA Testing Playground
Unified API Gateway playground for all Oriyon International microservices. 

#### QA Authorization Flow:
1. Hit **POST** \`/api/auth/login\` with credentials (e.g., admin credentials: \`admin@oriyon.ng\` / \`Admin@Oriyon2025\`).
2. Copy the returned \`accessToken\`.
3. Click the **Authorize** lock icon at the top right of this page.
4. Enter your token as \`Bearer <your_token_here>\` or just paste the token if prompt only asks for JWT, then click Authorize.
5. All protected endpoints will now utilize this token automatically!`,
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local API Gateway",
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Enter the Bearer token (JWT) to access protected routes. E.g., 'Bearer <token>'",
      },
    },
    schemas: {
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "admin@oriyon.ng" },
          password: { type: "string", format: "password", example: "Admin@Oriyon2025" },
        },
      },
      LoginResponse: {
        type: "object",
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          role: { type: "string", enum: ["trainee", "trainer", "admin"] },
        },
      },
      RefreshRequest: {
        type: "object",
        required: ["refreshToken"],
        properties: {
          refreshToken: { type: "string" },
        },
      },
      ForgotPasswordRequest: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", format: "email", example: "student@oriyon.ng" },
        },
      },
      SetPasswordRequest: {
        type: "object",
        required: ["token", "password"],
        properties: {
          token: { type: "string" },
          password: { type: "string", minLength: 8 },
        },
      },
      ResetPasswordRequest: {
        type: "object",
        required: ["token", "password"],
        properties: {
          token: { type: "string" },
          password: { type: "string", minLength: 8 },
        },
      },
      ChangePasswordRequest: {
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: {
          currentPassword: { type: "string" },
          newPassword: { type: "string", minLength: 8 },
        },
      },
      ApplicationSubmitRequest: {
        type: "object",
        required: ["firstName", "lastName", "email", "phone"],
        properties: {
          firstName: { type: "string", example: "John" },
          lastName: { type: "string", example: "Doe" },
          email: { type: "string", format: "email", example: "johndoe@example.com" },
          phone: { type: "string", example: "+2348012345678" },
          age: { type: "string", example: "25" },
          gender: { type: "string", example: "male" },
          address: { type: "string", example: "123 Pilot State, Oyo Road, Ibadan" },
          hasID: { type: "string", example: "yes" },
          businessName: { type: "string", example: "Doe Farms" },
          isCoop: { type: "string", example: "no" },
          isCommunityMember: { type: "string", example: "yes" },
          joinCoop: { type: "string", example: "yes" },
          educationLevel: { type: "string", example: "diploma" },
          fieldOfStudy: { type: "string", example: "Agriculture" },
          graduationYear: { type: "string", example: "2022" },
          institution: { type: "string", example: "University of Ibadan" },
          hasGoatExperience: { type: "string", example: "yes" },
          goatExperienceRating: { type: "string", example: "4" },
          ownsGoatFarm: { type: "string", example: "yes" },
          yearsOperated: { type: "string", example: "3" },
          highestAnimals: { type: "string", example: "20" },
          isDigitallyLiterate: { type: "string", example: "yes" },
          digitalLiteracyRating: { type: "string", example: "5" },
          internetUsage: { type: "string", example: "daily" },
          devices: { type: "array", items: { type: "string" }, example: ["smartphone"] },
          onlineTraining: { type: "string", example: "no" },
          platformExperience: { type: "string", example: "none" },
          toolConfidence: { type: "string", example: "high" },
          isBreadwinner: { type: "string", example: "yes" },
          hasDependants: { type: "string", example: "yes" },
          dependantsDetail: { type: "string", example: "3 children" },
          dependantsSchoolAge: { type: "string", example: "all" },
          hasDisabledInHousehold: { type: "string", example: "no" },
          disabledDetail: { type: "string", example: "" },
          benefitedBefore: { type: "string", example: "no" },
          benefitedDetail: { type: "string", example: "" },
          biggestChallenge: { type: "array", items: { type: "string" }, example: ["funding", "knowledge"] },
          whyJoin: { type: "string", example: "To expand my goat farming business" },
          hopesToAchieve: { type: "string", example: "Sustainable income and business growth" },
          willingTraceability: { type: "string", example: "yes" },
          hasAccess: { type: "array", items: { type: "string" }, example: ["land"] },
          willingChampion: { type: "string", example: "yes" },
          willingDonate: { type: "string", example: "yes" },
          committedFullTraining: { type: "string", example: "yes" },
          reference1: { type: "string", example: "Pastor Samuel" },
          reference2: { type: "string", example: "Chief Ade" },
          understandsCredit: { type: "boolean", example: true },
          declarationConfirmed: { type: "boolean", example: true },
        },
      },
      CooperativeJoinRequest: {
        type: "object",
        required: ["agreesToConstitution", "willingToContribute"],
        properties: {
          applicationId: { type: "string", format: "uuid" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          address: { type: "string" },
          livestockType: { type: "string" },
          agreesToConstitution: { type: "boolean", example: true },
          willingToContribute: { type: "boolean", example: true },
        },
      },
      UserCreateRequest: {
        type: "object",
        required: ["id", "email", "firstName", "lastName"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          role: { type: "string", enum: ["trainee", "trainer", "admin"], default: "trainee" },
        },
      },
      UserPatchRequest: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          isActive: { type: "boolean" },
        },
      },
      CohortCreateRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", example: "Cohort 1 (Oyo State)" },
          description: { type: "string" },
          state: { type: "string", example: "oyo" },
          startDate: { type: "string", format: "date-time" },
          endDate: { type: "string", format: "date-time" },
        },
      },
      CohortPatchRequest: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          state: { type: "string" },
          startDate: { type: "string", format: "date-time" },
          endDate: { type: "string", format: "date-time" },
        },
      },
      GroupCreateRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", example: "Group A - Oyo trainees" },
          description: { type: "string" },
        },
      },
      AddGroupMemberRequest: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string", format: "uuid" },
        },
      },
      WeekCreateRequest: {
        type: "object",
        required: ["cohortId", "weekNumber", "title"],
        properties: {
          cohortId: { type: "string", format: "uuid" },
          weekNumber: { type: "integer", example: 1 },
          title: { type: "string", example: "Introduction to Goat Husbandry" },
          description: { type: "string" },
          isPublished: { type: "boolean", default: false },
        },
      },
      LessonCreateRequest: {
        type: "object",
        required: ["weekId", "title", "type", "order"],
        properties: {
          weekId: { type: "string", format: "uuid" },
          title: { type: "string", example: "Lesson 1: Breeds of Goats" },
          description: { type: "string" },
          type: { type: "string", enum: ["video", "document", "quiz"], default: "video" },
          contentUrl: { type: "string" },
          duration: { type: "integer", example: 15 },
          order: { type: "integer", example: 1 },
          isPublished: { type: "boolean", default: false },
        },
      },
      ProgressCreateRequest: {
        type: "object",
        required: ["lessonId", "completed"],
        properties: {
          lessonId: { type: "string", format: "uuid" },
          completed: { type: "boolean", default: true },
          watchTime: { type: "integer" },
        },
      },
      SessionCreateRequest: {
        type: "object",
        required: ["cohortId", "weekId", "title", "type", "scheduledAt"],
        properties: {
          cohortId: { type: "string", format: "uuid" },
          weekId: { type: "string", format: "uuid" },
          title: { type: "string", example: "Live Q&A Session" },
          description: { type: "string" },
          type: { type: "string", enum: ["online", "physical"] },
          scheduledAt: { type: "string", format: "date-time" },
          durationMinutes: { type: "integer", example: 60 },
          link: { type: "string" },
          venue: { type: "string" },
        },
      },
      AssignFacilitatorRequest: {
        type: "object",
        required: ["trainerId"],
        properties: {
          trainerId: { type: "string", format: "uuid" },
        },
      },
      QuizCreateRequest: {
        type: "object",
        required: ["weekId", "title", "passingScore", "questions"],
        properties: {
          weekId: { type: "string", format: "uuid" },
          title: { type: "string" },
          description: { type: "string" },
          passingScore: { type: "integer", example: 70 },
          questions: {
            type: "array",
            items: {
              type: "object",
              required: ["questionText", "options", "correctOptionIndex"],
              properties: {
                questionText: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                correctOptionIndex: { type: "integer" },
              },
            },
          },
        },
      },
      QuizAttemptRequest: {
        type: "object",
        required: ["answers"],
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              required: ["questionId", "selectedOptionIndex"],
              properties: {
                questionId: { type: "string", format: "uuid" },
                selectedOptionIndex: { type: "integer" },
              },
            },
          },
        },
      },
      ExamCreateRequest: {
        type: "object",
        required: ["title", "passingScore", "durationMinutes"],
        properties: {
          weekId: { type: "string", format: "uuid" },
          title: { type: "string", example: "Final Examination" },
          description: { type: "string" },
          passingScore: { type: "integer", example: 60 },
          durationMinutes: { type: "integer", example: 120 },
          isPublished: { type: "boolean", default: false },
        },
      },
      ExamAutosaveRequest: {
        type: "object",
        required: ["answers"],
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              required: ["questionId"],
              properties: {
                questionId: { type: "string", format: "uuid" },
                selectedOptionIndex: { type: "integer" },
                textAnswer: { type: "string" },
              },
            },
          },
        },
      },
      ExamViolationsRequest: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", example: "tab-switch" },
          details: { type: "string" },
        },
      },
      ExamQuestionCreateRequest: {
        type: "object",
        required: ["questionText", "type"],
        properties: {
          questionText: { type: "string" },
          type: { type: "string", enum: ["mcq", "theory"] },
          options: { type: "array", items: { type: "string" } },
          correctOptionIndex: { type: "integer" },
          points: { type: "integer", default: 1 },
        },
      },
      ExamMarkTheoryRequest: {
        type: "object",
        required: ["pointsObtained"],
        properties: {
          pointsObtained: { type: "number", example: 4.5 },
          feedback: { type: "string" },
        },
      },
      ContactRequest: {
        type: "object",
        required: ["name", "email", "subject", "message"],
        properties: {
          name: { type: "string", example: "John Doe" },
          email: { type: "string", format: "email", example: "johndoe@example.com" },
          subject: { type: "string", example: "Question about admissions" },
          message: { type: "string", example: "Hello, when will the pilot cohort starts?" },
        },
      },
      NewsletterRequest: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", format: "email", example: "newsletter@example.com" },
        },
      },
    },
  },
  paths: {
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in with email and password",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LoginRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Successful login",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          401: { description: "Invalid credentials" },
        },
      },
    },
    "/api/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Refresh access token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RefreshRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "New access token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { accessToken: { type: "string" } },
                },
              },
            },
          },
          401: { description: "Invalid/expired refresh token" },
        },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Log out and invalidate refresh token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RefreshRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Successfully logged out",
          },
        },
      },
    },
    "/api/auth/set-password": {
      post: {
        tags: ["Auth"],
        summary: "First-time account setup & password creation via emailed setup token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SetPasswordRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Password set and logged in successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          400: { description: "Invalid, used, or expired token" },
        },
      },
    },
    "/api/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Request a password reset link (emailed to user)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ForgotPasswordRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Reset email will be sent if account exists",
          },
        },
      },
    },
    "/api/auth/resend-setup": {
      post: {
        tags: ["Auth"],
        summary: "Resend first-time setup token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ForgotPasswordRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Setup link sent if account is pending setup",
          },
        },
      },
    },
    "/api/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Reset password using reset token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResetPasswordRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Password reset completed successfully",
          },
          400: { description: "Invalid or expired token" },
        },
      },
    },
    "/api/auth/change-password": {
      patch: {
        tags: ["Auth"],
        summary: "Change password (for logged-in user)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChangePasswordRequest" },
            },
          },
        },
        responses: {
          200: { description: "Password changed successfully" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/api/applications": {
      post: {
        tags: ["Applications"],
        summary: "Submit a new EEWYLA program intake application",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationSubmitRequest" },
            },
          },
        },
        responses: {
          201: {
            description: "Application submitted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    id: { type: "string", format: "uuid" },
                    status: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        tags: ["Applications"],
        summary: "Get all active applications (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "List of applications",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
    },
    "/api/applications/status/{status}": {
      get: {
        tags: ["Applications"],
        summary: "Filter applications by status (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "status",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"],
            },
          },
        ],
        responses: {
          200: {
            description: "Filtered applications list",
          },
        },
      },
    },
    "/api/applications/{id}": {
      get: {
        tags: ["Applications"],
        summary: "Get individual application detail by ID (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Application details" },
          404: { description: "Not found" },
        },
      },
      patch: {
        tags: ["Applications"],
        summary: "Admin update/approve/reject application (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pending", "shortlisted", "approved", "rejection_review", "rejected", "archived"] },
                  cohortId: { type: "string", format: "uuid" },
                  reviewNotes: { type: "string" },
                  rejectionReason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Application updated successfully" },
        },
      },
      delete: {
        tags: ["Applications"],
        summary: "Soft delete application (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Application deleted successfully" },
        },
      },
    },
    "/api/applications/admin/analytics": {
      get: {
        tags: ["Applications"],
        summary: "Fetch administrative application analytics (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Analytics dashboard metrics",
          },
        },
      },
    },
    "/api/applications/{id}/rescue": {
      patch: {
        tags: ["Applications"],
        summary: "Rescue application from rejection_review back to shortlisted (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  reviewNotes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Application rescued" },
        },
      },
    },
    "/api/cooperative/join": {
      post: {
        tags: ["Cooperative"],
        summary: "Join the EEWYLA Cooperative",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CooperativeJoinRequest" },
            },
          },
        },
        responses: {
          201: { description: "Joined cooperative successfully" },
        },
      },
    },
    "/api/cooperative/members": {
      get: {
        tags: ["Cooperative"],
        summary: "List all cooperative members (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Cooperative member list" },
        },
      },
    },
    "/api/cooperative/members/{id}": {
      get: {
        tags: ["Cooperative"],
        summary: "Get a specific cooperative member (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Cooperative member details" },
        },
      },
      patch: {
        tags: ["Cooperative"],
        summary: "Update cooperative member record (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["active", "inactive"] },
                  livestockType: { type: "string" },
                  willingToContribute: { type: "boolean" },
                  agreesToConstitution: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Member updated" },
        },
      },
    },
    "/api/cooperative/by-application/{applicationId}": {
      get: {
        tags: ["Cooperative"],
        summary: "Get cooperative member by application ID (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "applicationId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Member details" },
        },
      },
    },
    "/api/cooperative/stats": {
      get: {
        tags: ["Cooperative"],
        summary: "Get cooperative statistics summary (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Cooperative statistics summary" },
        },
      },
    },
    "/api/contact": {
      post: {
        tags: ["Contact & Newsletter"],
        summary: "Submit public contact form",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ContactRequest" },
            },
          },
        },
        responses: {
          200: { description: "Contact query submitted" },
        },
      },
    },
    "/api/newsletter/subscribe": {
      post: {
        tags: ["Contact & Newsletter"],
        summary: "Subscribe email to the mailing list",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewsletterRequest" },
            },
          },
        },
        responses: {
          200: { description: "Subscribed successfully" },
        },
      },
    },
    "/api/newsletter/unsubscribe": {
      delete: {
        tags: ["Contact & Newsletter"],
        summary: "Unsubscribe email from the mailing list",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewsletterRequest" },
            },
          },
        },
        responses: {
          200: { description: "Unsubscribed successfully" },
        },
      },
    },
    "/api/users": {
      get: {
        tags: ["Users"],
        summary: "Get all users",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Users list" },
        },
      },
      post: {
        tags: ["Users"],
        summary: "Directly create a user profile (syncs from Auth approvals)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "User profile created" },
        },
      },
    },
    "/api/users/{id}": {
      get: {
        tags: ["Users"],
        summary: "Get a specific user by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "User details" },
        },
      },
      patch: {
        tags: ["Users"],
        summary: "Update user profile details",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserPatchRequest" },
            },
          },
        },
        responses: {
          200: { description: "User profile updated" },
        },
      },
      delete: {
        tags: ["Users"],
        summary: "Deactivate user (soft delete)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "User deactivated successfully" },
        },
      },
    },
    "/api/users/{id}/id-document": {
      get: {
        tags: ["Users"],
        summary: "Download ID document binary/file (Admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Binary file response" },
        },
      },
      patch: {
        tags: ["Users"],
        summary: "Upload identity document for verification",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  document: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Document uploaded" },
        },
      },
    },
    "/api/users/{id}/id-document/meta": {
      get: {
        tags: ["Users"],
        summary: "Get identity document metadata for verification",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Metadata details of uploaded ID" },
        },
      },
    },
    "/api/admin/results": {
      get: {
        tags: ["Admin Dashboard"],
        summary: "Fetch aggregated results of all quiz attempts and exam sessions (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Aggregated learning results" },
        },
      },
    },
    "/api/cohorts": {
      get: {
        tags: ["Cohorts & Groups"],
        summary: "List all cohorts",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "List of cohorts" },
        },
      },
      post: {
        tags: ["Cohorts & Groups"],
        summary: "Create a new cohort",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CohortCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Cohort created successfully" },
        },
      },
    },
    "/api/cohorts/{id}": {
      get: {
        tags: ["Cohorts & Groups"],
        summary: "Get cohort details and active members list by cohort ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Cohort details" },
        },
      },
      patch: {
        tags: ["Cohorts & Groups"],
        summary: "Update cohort properties",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CohortPatchRequest" },
            },
          },
        },
        responses: {
          200: { description: "Cohort updated" },
        },
      },
    },
    "/api/cohorts/{id}/enrol": {
      post: {
        tags: ["Cohorts & Groups"],
        summary: "Enrol a user into a cohort (triggers event to seed LMS progress)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userId"],
                properties: { userId: { type: "string", format: "uuid" } },
              },
            },
          },
        },
        responses: {
          201: { description: "User enrolled successfully" },
        },
      },
    },
    "/api/cohorts/{id}/groups": {
      get: {
        tags: ["Cohorts & Groups"],
        summary: "List all groups belonging to a cohort (with members lists)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Groups list" },
        },
      },
      post: {
        tags: ["Cohorts & Groups"],
        summary: "Create a learning group inside a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GroupCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Group created successfully" },
        },
      },
    },
    "/api/groups/{id}": {
      get: {
        tags: ["Cohorts & Groups"],
        summary: "Get a specific group with detailed members list by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Group details" },
        },
      },
    },
    "/api/cohorts/{cohortId}/groups/{groupId}/members": {
      post: {
        tags: ["Cohorts & Groups"],
        summary: "Add a member to a learning group inside a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "cohortId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "groupId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AddGroupMemberRequest" },
            },
          },
        },
        responses: {
          201: { description: "Member added successfully" },
        },
      },
    },
    "/api/lms/weeks": {
      get: {
        tags: ["LMS Weeks"],
        summary: "Get weeks in curriculum",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "List of curriculum weeks" },
        },
      },
      post: {
        tags: ["LMS Weeks"],
        summary: "Create a curriculum week",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WeekCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Curriculum week created" },
        },
      },
    },
    "/api/lms/weeks/{id}": {
      get: {
        tags: ["LMS Weeks"],
        summary: "Get detailed curriculum week by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Curriculum week details" },
        },
      },
      patch: {
        tags: ["LMS Weeks"],
        summary: "Update curriculum week",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  isPublished: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Curriculum week updated" },
        },
      },
    },
    "/api/lms/lessons": {
      post: {
        tags: ["LMS Lessons"],
        summary: "Create a new curriculum lesson",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LessonCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Lesson created" },
        },
      },
    },
    "/api/lms/lessons/{id}": {
      get: {
        tags: ["LMS Lessons"],
        summary: "Get specific lesson by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Lesson details" },
        },
      },
      patch: {
        tags: ["LMS Lessons"],
        summary: "Update lesson",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  type: { type: "string", enum: ["video", "document", "quiz"] },
                  contentUrl: { type: "string" },
                  duration: { type: "integer" },
                  isPublished: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Lesson updated" },
        },
      },
    },
    "/api/lms/progress": {
      post: {
        tags: ["LMS Progress"],
        summary: "Track/Submit trainee progress for a lesson (triggers completion milestone emails)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProgressCreateRequest" },
            },
          },
        },
        responses: {
          200: { description: "Lesson progress tracked successfully" },
        },
      },
    },
    "/api/lms/progress/{userId}": {
      get: {
        tags: ["LMS Progress"],
        summary: "Get learning progress details for a trainee",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Trainee learning progress overview" },
        },
      },
    },
    "/api/lms/progress/cohort/{cohortId}": {
      get: {
        tags: ["LMS Progress"],
        summary: "Get progress stats aggregated for a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "cohortId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Cohort learning progress overview" },
        },
      },
    },
    "/api/lms/sessions": {
      get: {
        tags: ["LMS Sessions"],
        summary: "Get cohort training sessions (filterable by cohortId and weekId)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cohortId", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "weekId", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Training sessions list" },
        },
      },
      post: {
        tags: ["LMS Sessions"],
        summary: "Create a training session (online or physical)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SessionCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Training session created" },
        },
      },
    },
    "/api/lms/sessions/{id}": {
      patch: {
        tags: ["LMS Sessions"],
        summary: "Update session details",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  scheduledAt: { type: "string", format: "date-time" },
                  durationMinutes: { type: "integer" },
                  link: { type: "string" },
                  venue: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Session updated" },
        },
      },
    },
    "/api/lms/sessions/{id}/assign": {
      post: {
        tags: ["LMS Sessions"],
        summary: "Assign facilitator (trainer) to a session",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssignFacilitatorRequest" },
            },
          },
        },
        responses: {
          200: { description: "Facilitator assigned successfully" },
        },
      },
    },
    "/api/lms/stats/summary": {
      get: {
        tags: ["LMS Dashboard Stats"],
        summary: "Get general summary stats for LMS",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Dashboard summary stats" },
        },
      },
    },
    "/api/lms/quizzes/admin/attempts": {
      get: {
        tags: ["LMS Quizzes"],
        summary: "Get all quiz attempts across students (Admin only)",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Quiz attempts list" },
        },
      },
    },
    "/api/lms/quizzes/week/{weekId}": {
      get: {
        tags: ["LMS Quizzes"],
        summary: "Get quizzes for a specific week",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "weekId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Quizzes list for week" },
        },
      },
    },
    "/api/lms/quizzes": {
      post: {
        tags: ["LMS Quizzes"],
        summary: "Create a new quiz with questions",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/QuizCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Quiz created successfully" },
        },
      },
    },
    "/api/lms/quizzes/{id}": {
      get: {
        tags: ["LMS Quizzes"],
        summary: "Get detailed quiz by quiz ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Quiz details" },
        },
      },
      patch: {
        tags: ["LMS Quizzes"],
        summary: "Update quiz metadata",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  passingScore: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Quiz updated" },
        },
      },
    },
    "/api/lms/quizzes/{id}/attempt": {
      post: {
        tags: ["LMS Quizzes"],
        summary: "Submit attempt/answers for a quiz (evaluates and returns grade immediately)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/QuizAttemptRequest" },
            },
          },
        },
        responses: {
          200: { description: "Quiz attempt evaluated result details" },
        },
      },
    },
    "/api/lms/quizzes/{id}/attempts/{userId}": {
      get: {
        tags: ["LMS Quizzes"],
        summary: "Get all quiz attempts details for a user",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Attempt history" },
        },
      },
    },
    "/api/lms/exams": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get list of available exams",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "Exams list" },
        },
      },
      post: {
        tags: ["LMS Exams"],
        summary: "Create a new exam curriculum block",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExamCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Exam created" },
        },
      },
    },
    "/api/lms/exams/{id}": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get detailed exam configuration by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Exam details" },
        },
      },
      patch: {
        tags: ["LMS Exams"],
        summary: "Update exam configuration metadata",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  passingScore: { type: "integer" },
                  durationMinutes: { type: "integer" },
                  isPublished: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Exam updated" },
        },
      },
    },
    "/api/lms/exams/{id}/questions": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get questions belonging to an exam",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "List of exam questions" },
        },
      },
      post: {
        tags: ["LMS Exams"],
        summary: "Create and add a question to an exam (MCQ or Theory)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExamQuestionCreateRequest" },
            },
          },
        },
        responses: {
          201: { description: "Question added successfully" },
        },
      },
    },
    "/api/lms/exams/questions/{questionId}": {
      patch: {
        tags: ["LMS Exams"],
        summary: "Update an exam question",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "questionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  questionText: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                  correctOptionIndex: { type: "integer" },
                  points: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Question updated" },
        },
      },
      delete: {
        tags: ["LMS Exams"],
        summary: "Delete an exam question",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "questionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Question deleted" },
        },
      },
    },
    "/api/lms/exams/{id}/sessions/start": {
      post: {
        tags: ["LMS Exams"],
        summary: "Start a proctored assessment session for an exam",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          201: { description: "Exam session started" },
        },
      },
    },
    "/api/lms/exams/sessions/{sessionId}/autosave": {
      patch: {
        tags: ["LMS Exams"],
        summary: "Autosave answer state dynamically during exam",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExamAutosaveRequest" },
            },
          },
        },
        responses: {
          200: { description: "Answers saved successfully" },
        },
      },
    },
    "/api/lms/exams/sessions/{sessionId}/submit": {
      post: {
        tags: ["LMS Exams"],
        summary: "Submit final answers for the exam (finishes session, triggers results emails)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Exam submitted successfully" },
        },
      },
    },
    "/api/lms/exams/sessions/{sessionId}/violations": {
      post: {
        tags: ["LMS Exams"],
        summary: "Log a proctoring boundary violation event (e.g. fullscreen exits, tab switches)",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExamViolationsRequest" },
            },
          },
        },
        responses: {
          201: { description: "Violation event recorded" },
        },
      },
    },
    "/api/lms/exams/sessions/{sessionId}/result": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get current score and result details for a specific session",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Session evaluation result details" },
        },
      },
    },
    "/api/lms/exams/sessions/{sessionId}/answers": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get submitted answers for marking/review",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "sessionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "List of submitted student answers" },
        },
      },
    },
    "/api/lms/exams/answers/{answerId}/mark": {
      patch: {
        tags: ["LMS Exams"],
        summary: "Grade and award points for a theory answer",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "answerId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ExamMarkTheoryRequest" },
            },
          },
        },
        responses: {
          200: { description: "Theory answer graded successfully" },
        },
      },
    },
    "/api/lms/exams/{id}/sessions": {
      get: {
        tags: ["LMS Exams"],
        summary: "Get all sessions started/submitted for an exam",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Sessions list" },
        },
      },
    },
    "/api/lms/week12/codes": {
      post: {
        tags: ["LMS Week 12 Attendance"],
        summary: "Generate check-in code for a week 12 session",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cohortId", "code"],
                properties: {
                  cohortId: { type: "string", format: "uuid" },
                  code: { type: "string", example: "W12- Oyo- 9982" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Check-in code registered" },
        },
      },
    },
    "/api/lms/week12/codes/{cohortId}": {
      get: {
        tags: ["LMS Week 12 Attendance"],
        summary: "Get active check-in codes for a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "cohortId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Active attendance codes details" },
        },
      },
    },
    "/api/lms/week12/checkin": {
      post: {
        tags: ["LMS Week 12 Attendance"],
        summary: "Trainee submits check-in code to mark attendance",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code"],
                properties: {
                  code: { type: "string", example: "W12- Oyo- 9982" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Trainee check-in recorded successfully" },
        },
      },
    },
    "/api/lms/week12/checkins/{cohortId}": {
      get: {
        tags: ["LMS Week 12 Attendance"],
        summary: "List all trainee check-ins recorded for a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "cohortId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          200: { description: "Check-ins log list" },
        },
      },
    },
    "/api/lms/week12/checkins/{cohortId}/{userId}": {
      get: {
        tags: ["LMS Week 12 Attendance"],
        summary: "Get attendance details for a specific trainee in a cohort",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cohortId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Trainee attendance log details" },
        },
      },
    },
  },
};
