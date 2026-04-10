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

| Service | Port | DB | Description |
|---|---|---|---|
| api-gateway | 3000 | — | JWT auth + request proxy |
| auth-service | 3001 | oriyon_auth | Login, token issuance |
| user-service | 3002 | oriyon_user | Users, cohorts, enrolment |
| lms-service | 3003 | oriyon_lms | Curriculum, progress, sessions |
| applications-service | 3004 | oriyon_applications | EEWYLA applications |
| notifications-service | 3005 | oriyon_notifications | Email + newsletter |

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
# In separate terminals, or via docker exec:
docker exec oriyon-auth-service npm run db:migrate
docker exec oriyon-user-service npm run db:migrate
docker exec oriyon-lms-service npm run db:migrate
docker exec oriyon-applications-service npm run db:migrate
docker exec oriyon-notifications-service npm run db:migrate
```

### 4. RabbitMQ Management UI

Visit http://localhost:15672
Login with `RABBITMQ_USER` / `RABBITMQ_PASS` from your `.env`

---

## RabbitMQ Event Map

| Routing Key | Producer | Consumers |
|---|---|---|
| `user.created` | user-service | notifications-service |
| `user.enrolled` | user-service | lms-service |
| `user.logged_in` | auth-service | (audit) |
| `application.submitted` | applications-service | notifications-service |
| `application.approved` | applications-service | user-service, notifications-service |
| `application.rejected` | applications-service | notifications-service |
| `lesson.completed` | lms-service | notifications-service |
| `week.completed` | lms-service | notifications-service |

---

## API Endpoints (via Gateway on :3000)

### Public
```
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
POST   /api/applications          EEWYLA application form
POST   /api/contact               Contact form
POST   /api/newsletter/subscribe
DELETE /api/newsletter/unsubscribe
```

### Protected (Bearer token required)
```
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

GET    /api/applications          (admin only)
GET    /api/applications/:id
PATCH  /api/applications/:id
```
