# Oriyon International — Backend Microservices

Full microservice backend for oriyoninternational.com built with:
**Node.js · TypeScript · Express · PostgreSQL · Drizzle ORM · RabbitMQ · Docker**

---

## Architecture

```
                        ┌─────────────────┐
  Next.js Frontend ───▶ │   API Gateway   │ :3000
                        └────────┬────────┘
                                 │ JWT verify + proxy
          ┌──────────────────────┼──────────────────────┐
          │                      │                       │
   ┌──────▼──────┐    ┌──────────▼──────┐    ┌─────────▼──────────┐
   │ auth-service│    │  user-service   │    │   lms-service      │
   │    :3001    │    │     :3002       │    │      :3003         │
   └─────────────┘    └─────────────────┘    └────────────────────┘
          │                      │                       │
   ┌──────▼──────────────────────▼───────────────────────▼───────┐
   │                        RabbitMQ                             │
   │               Exchange: oriyon.events (topic)               │
   └──────┬──────────────────────────────────────┬──────────────┘
          │                                      │
   ┌──────▼────────────────┐    ┌────────────────▼──────────────┐
   │ applications-service  │    │   notifications-service       │
   │        :3004          │    │          :3005                │
   └───────────────────────┘    └───────────────────────────────┘
```

---

## Services

| Service | Port | Database | Description |
|---|---|---|---|
| api-gateway | 3000 | — | JWT auth + request proxy |
| auth-service | 3001 | oriyon_auth | Credentials, tokens, password management |
| user-service | 3002 | oriyon_user | Users, cohorts, enrolment |
| lms-service | 3003 | oriyon_lms | Curriculum, progress, sessions |
| applications-service | 3004 | oriyon_applications | EEWYLA programme applications |
| notifications-service | 3005 | oriyon_notifications | Email delivery + newsletter |

---

## User Journey — How Someone Joins the Platform

Users cannot self-register. Every account is created through the application and approval flow.

```
1. Applicant submits EEWYLA application form
         │
         ▼
2. applications-service saves record
   publishes → application.submitted
         │
         ▼
3. notifications-service sends confirmation email to applicant

4. Admin reviews application via dashboard
   PATCH /api/applications/:id  { status: "approved" | "rejected" }
         │
         ├── rejected → application.rejected event
         │              notifications-service sends rejection email
         │
         └── approved → application.approved event
                  │
                  ▼
         5. user-service receives event
            creates user profile in oriyon_user DB
            publishes → user.created
                  │
                  ▼
         6. auth-service receives user.created
            creates auth record (no password yet)
            generates one-time setup token (24hr expiry)
            publishes → user.setup_requested
                  │
                  ▼
         7. notifications-service sends setup email
            "Click here to set your password" (link expires 24hrs)
                  │
                  ▼
         8. User clicks link, sets their password
            POST /api/auth/set-password
                  │
                  ▼
         9. User is logged in automatically
            access token + refresh token issued
                  │
                  ▼
         10. User accesses LMS portal
```

---

## Auth Flow

The platform uses JWT-based authentication with short-lived access tokens and long-lived refresh tokens.

| Token | Expiry | Storage |
|---|---|---|
| Access token | 15 minutes | Memory (JS variable) |
| Refresh token | 7 days | localStorage |

**Password routes:**

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | Public | Login with email + password |
| `POST /api/auth/refresh` | Public | Get new access token using refresh token |
| `POST /api/auth/logout` | Public | Invalidate refresh token |
| `POST /api/auth/set-password` | Public | First-time password setup via emailed token |
| `POST /api/auth/forgot-password` | Public | Request password reset link |
| `POST /api/auth/reset-password` | Public | Submit new password via reset token |
| `PATCH /api/auth/change-password` | Protected | Logged-in user changes their password |
| `GET /api/auth/verify` | Internal | Called by gateway to verify JWT |

---

## RabbitMQ Event Map

All events are published to the `oriyon.events` topic exchange. Each consumer service has its own durable queue, so events are never lost if a service is temporarily down.

| Routing Key | Producer | Consumers | Trigger |
|---|---|---|---|
| `application.submitted` | applications-service | notifications-service | Applicant submits form |
| `application.approved` | applications-service | user-service, notifications-service | Admin approves |
| `application.rejected` | applications-service | notifications-service | Admin rejects |
| `user.created` | user-service | auth-service | User profile created |
| `user.setup_requested` | auth-service | notifications-service | Auth record + setup token created |
| `user.enrolled` | user-service | lms-service | Student enrolled into cohort |
| `user.logged_in` | auth-service | (audit) | Successful login |
| `auth.password_reset_requested` | auth-service | notifications-service | Forgot password request |
| `lesson.completed` | lms-service | notifications-service | Student finishes a lesson |
| `week.completed` | lms-service | notifications-service | Student finishes all lessons in a week |

---

## LMS Flow

The LMS is structured around cohorts, weeks, and lessons. Each cohort has its own set of weeks so different cohorts can run on different schedules.

```
Cohort
  └── Week 1 (weekNumber: 1, cohortId: xxx)
        ├── Lesson 1 (order: 1, isPublished: true)
        ├── Lesson 2 (order: 2)
        └── Lesson 3 (order: 3)
  └── Week 2
        └── ...
```

**Enrolment → progress seeding:**
When a student is enrolled into a cohort (`POST /api/cohorts/:id/enrol`), lms-service listens to the `user.enrolled` event and automatically seeds empty progress records for every published lesson in that cohort. This enables accurate completion percentage calculation from day one.

**Lesson completion:**
When a student completes a lesson (`POST /api/lms/progress`), lms-service:
1. Marks the progress record as `completed: true`
2. Fetches the user's email and name from user-service
3. Publishes `lesson.completed` — notifications-service sends a milestone email
4. Checks if all lessons in the week are now complete
5. If yes, publishes `week.completed` — notifications-service sends a congratulations email

**Sessions:**
Physical and online sessions are scoped per cohort and per week. This means different cohorts attending the same week's session can have different dates, venues, and facilitators.

```
GET /api/lms/sessions?cohortId=xxx&weekId=yyy
→ Returns only that cohort's session for that specific week
```

---

## API Endpoints (via Gateway on :3000)

### Public
```
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
POST   /api/auth/set-password
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
POST   /api/applications              EEWYLA application form
POST   /api/contact                   Contact form
POST   /api/newsletter/subscribe
DELETE /api/newsletter/unsubscribe
```

### Protected (Bearer token required)
```
PATCH  /api/auth/change-password

GET    /api/users
POST   /api/users
GET    /api/users/:id
PATCH  /api/users/:id
DELETE /api/users/:id

GET    /api/cohorts
POST   /api/cohorts
GET    /api/cohorts/:id
PATCH  /api/cohorts/:id
POST   /api/cohorts/:id/enrol

GET    /api/lms/weeks
POST   /api/lms/weeks
GET    /api/lms/weeks/:id
PATCH  /api/lms/weeks/:id
GET    /api/lms/lessons/:id
POST   /api/lms/lessons
PATCH  /api/lms/lessons/:id
POST   /api/lms/progress
GET    /api/lms/progress/:userId
GET    /api/lms/progress/cohort/:cohortId
GET    /api/lms/sessions
POST   /api/lms/sessions
PATCH  /api/lms/sessions/:id
POST   /api/lms/sessions/:id/assign
GET    /api/lms/stats/summary

GET    /api/applications              (admin only)
GET    /api/applications/:id          (admin only)
PATCH  /api/applications/:id          (admin only)
```

---

## Quick Start

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env with your real values
```

### 2. Start everything

```bash
docker compose up --build
```

### 3. Run migrations (first time)

```bash
docker exec oriyon-auth-service npm run db:migrate
docker exec oriyon-user-service npm run db:migrate
docker exec oriyon-lms-service npm run db:migrate
docker exec oriyon-applications-service npm run db:migrate
docker exec oriyon-notifications-service npm run db:migrate
```

### 4. Seed the first admin account

```bash
docker exec -it oriyon-auth-service sh
npx ts-node --transpile-only src/seed-admin.ts
```

Default credentials (override via env vars):
```
Email:    admin@oriyon.ng
Password: Admin@Oriyon2025
```

### 5. RabbitMQ Management UI

Visit http://localhost:15672  
Login with `RABBITMQ_USER` / `RABBITMQ_PASS` from your `.env`

---

## Environment Variables

Each service requires its own `.env`. Key variables:

```bash
# All services
DATABASE_URL=postgresql://...
RABBITMQ_URL=amqp://...

# api-gateway
FRONTEND_URL=https://www.oriyoninternational.com
JWT_SECRET=...
JWT_REFRESH_SECRET=...
AUTH_SERVICE_URL=http://auth-service:3001
USER_SERVICE_URL=http://user-service:3002
LMS_SERVICE_URL=http://lms-service:3003
APPLICATIONS_SERVICE_URL=http://applications-service:3004
NOTIFICATIONS_SERVICE_URL=http://notifications-service:3005

# auth-service
JWT_SECRET=...              # must match gateway
JWT_REFRESH_SECRET=...      # must match gateway
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
FRONTEND_URL=https://www.oriyoninternational.com

# notifications-service
RESEND_API_KEY=...
EMAIL_FROM=no-reply@oriyoninternational.com
FRONTEND_URL=https://www.oriyoninternational.com

# lms-service
USER_SERVICE_URL=http://user-service:3002
```

---

## Database Schema Overview

| Service | Tables |
|---|---|
| oriyon_auth | `auth_users`, `refresh_tokens`, `setup_tokens` |
| oriyon_user | `users`, `cohorts`, `cohort_members` |
| oriyon_lms | `weeks`, `lessons`, `progress`, `physical_sessions`, `session_groups` |
| oriyon_applications | `applications` |
| oriyon_notifications | `subscribers` |

---

## Tech Stack

| Technology | Role |
|---|---|
| Node.js + TypeScript | Runtime and type safety |
| Express | HTTP framework per service |
| PostgreSQL | Relational database (one per service) |
| Drizzle ORM | Type-safe DB queries |
| RabbitMQ | Async event messaging between services |
| Docker | Container orchestration |
| Resend | Transactional email delivery |
| bcryptjs | Password hashing |
| jsonwebtoken | JWT issuance and verification |
| zod | Request validation |