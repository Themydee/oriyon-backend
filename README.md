# Oriyon International — Backend Microservices

Full microservice backend for oriyoninternational.com built with:
**Node.js · TypeScript · Express · PostgreSQL · Drizzle ORM · RabbitMQ · Docker**

---

## Overview

This repository contains the backend for the Oriyon International learning platform.
The system is built as separate microservices connected through an API gateway and RabbitMQ events.
The front-end application lives in `../oriyon-website` and calls these services through `api-gateway`.

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

| Service | Port | Database | Responsibility |
|---|---|---|---|
| api-gateway | 3000 | — | JWT verification, proxy, unified API surface |
| auth-service | 3001 | oriyon_auth | Authentication, refresh tokens, password setup |
| user-service | 3002 | oriyon_user | User profiles, cohorts, enrolment |
| lms-service | 3003 | oriyon_lms | Curriculum, lessons, progress, sessions, exams |
| applications-service | 3004 | oriyon_applications | EEWYLA application intake |
| notifications-service | 3005 | oriyon_notifications | Email notifications, event-driven messaging |

---

## User Onboarding Flow

Accounts are created through the application approval workflow rather than self-registration.

1. Applicant submits EEWYLA application.
2. `applications-service` persists the application and publishes `application.submitted`.
3. `notifications-service` sends a confirmation email.
4. Admin reviews and approves/rejects the application.
5. Approval publishes `application.approved`.
6. `user-service` creates the user profile and publishes `user.created`.
7. `auth-service` creates the auth account, generates a setup token, and publishes `user.setup_requested`.
8. `notifications-service` sends the password setup email.
9. User clicks the setup link, sets a password, and receives tokens.
10. User can then access the LMS portal.

---

## Authentication

The backend uses JWTs with short-lived access tokens and long-lived refresh tokens.

| Token | Expiry | Storage |
|---|---|---|
| Access token | 15 minutes | In-memory client state |
| Refresh token | 7 days | localStorage |

### Key routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | Public | Login with email/password |
| `POST /api/auth/refresh` | Public | Refresh access token |
| `POST /api/auth/logout` | Public | Logout and invalidate refresh token |
| `POST /api/auth/set-password` | Public | First-time password setup |
| `POST /api/auth/forgot-password` | Public | Request password reset |
| `POST /api/auth/reset-password` | Public | Reset password via token |
| `PATCH /api/auth/change-password` | Protected | Change password for logged-in users |
| `GET /api/auth/verify` | Internal | Token verification by gateway |

---

## RabbitMQ Event Map

The system uses a topic exchange named `oriyon.events`.
Each service consumes messages from its own durable queue for reliability.

| Routing Key | Producer | Consumers | Purpose |
|---|---|---|---|
| `application.submitted` | applications-service | notifications-service | New application received |
| `application.approved` | applications-service | user-service, notifications-service | Application approved |
| `application.rejected` | applications-service | notifications-service | Application rejected |
| `user.created` | user-service | auth-service | Create auth account for new user |
| `user.setup_requested` | auth-service | notifications-service | Send password setup email |
| `user.enrolled` | user-service | lms-service | Enrol user into cohort and seed progress |
| `lesson.completed` | lms-service | notifications-service | Lesson completion milestone email |
| `week.completed` | lms-service | notifications-service | Week completion email |
| `exam.submitted` | lms-service | notifications-service | Exam submission summary email |

---

## LMS Flow

The LMS is built around cohorts, weeks, lessons, and a separate exam experience.
Weeks are ordered learning units; lessons belong to weeks and track completion.
Exams are not part of the normal weekly lesson progression — they occur after the core weekly curriculum, typically after week 12, and are exposed through their own dedicated exam page.

### Curriculum model

- Cohort → has many weeks
- Week → has many lessons
- Lesson → can be video or document and is publish-controlled
- Exam → can be associated with a week but is treated as a separate assessment event

### Weekly progression

- Students unlock lessons as weeks are published.
- Completing lessons updates progress and may publish `lesson.completed`.
- When all lessons in a week are finished, lms-service publishes `week.completed`.
- This triggers notifications for the student.

### Exam flow

Exams are handled as dedicated assessment sessions:

- `GET /api/lms/exams` — list available exams
- `GET /api/lms/exams/:id` — get exam details
- `POST /api/lms/exams/:id/sessions/start` — start an exam session
- `PATCH /api/lms/exams/sessions/:id/autosave` — autosave answers during the exam
- `POST /api/lms/exams/sessions/:id/submit` — submit exam answers
- `GET /api/lms/exams/sessions/:id/result` — fetch exam result status

Even though exams may reference `weekId`, they are surfaced on a standalone exam route and page, not inside the regular weekly lesson flow.

### Notifications

When an exam is submitted, lms-service publishes `exam.submitted` and notifications-service sends an email containing:
- student name
- exam title
- MCQ score
- pending review status
- any additional next-step guidance

---

## API Endpoints (Gateway on :3000)

### Public

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/set-password`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/applications`
- `POST /api/contact`
- `POST /api/newsletter/subscribe`
- `DELETE /api/newsletter/unsubscribe`

### Protected

- `PATCH /api/auth/change-password`
- `GET /api/users`
- `POST /api/users`
- `GET /api/users/:id`
- `PATCH /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/cohorts`
- `POST /api/cohorts`
- `GET /api/cohorts/:id`
- `PATCH /api/cohorts/:id`
- `POST /api/cohorts/:id/enrol`
- `GET /api/lms/weeks`
- `POST /api/lms/weeks`
- `GET /api/lms/weeks/:id`
- `PATCH /api/lms/weeks/:id`
- `GET /api/lms/lessons/:id`
- `POST /api/lms/lessons`
- `PATCH /api/lms/lessons/:id`
- `POST /api/lms/progress`
- `GET /api/lms/progress/:userId`
- `GET /api/lms/progress/cohort/:cohortId`
- `GET /api/lms/sessions`
- `POST /api/lms/sessions`
- `PATCH /api/lms/sessions/:id`
- `POST /api/lms/sessions/:id/assign`
- `GET /api/lms/stats/summary`
- `GET /api/lms/exams`
- `GET /api/lms/exams/:id`
- `POST /api/lms/exams/:id/sessions/start`
- `PATCH /api/lms/exams/sessions/:id/autosave`
- `POST /api/lms/exams/sessions/:id/submit`
- `GET /api/lms/exams/sessions/:id/result`
- `GET /api/applications`
- `GET /api/applications/:id`
- `PATCH /api/applications/:id`

---

## Local Development

### Environment

Copy the example env file and configure values for:
- database URLs
- RabbitMQ connection
- email provider / resend API key
- JWT secrets
- service ports

```bash
cp .env.example .env
```

### Start services

```bash
docker compose up --build
```

### Run migrations

```bash
docker exec oriyon-auth-service npm run db:migrate
docker exec oriyon-user-service npm run db:migrate
docker exec oriyon-lms-service npm run db:migrate
docker exec oriyon-applications-service npm run db:migrate
docker exec oriyon-notifications-service npm run db:migrate
```

### Seed initial admin

```bash
docker exec -it oriyon-auth-service sh
# then run seed script inside the container
```

### Useful commands

```bash
# Build all services from repo root if needed
npm run build
# Start only one service for isolation
cd services/lms-service && npm run dev
```

---

## Frontend

The frontend lives in `../oriyon-website` and consumes the backend through the gateway on port `3000`.
The exam experience is served through dedicated pages rather than a weekly page.

---

## Notes

- Exams are a separate assessment event and should appear as their own page in the learner portal.
- Week-based curriculum and exam delivery are intentionally separated.
- `notifications-service` handles email delivery for application, lesson, week, and exam events.

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