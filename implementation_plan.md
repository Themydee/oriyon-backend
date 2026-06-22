# Implementation Plan - LGA-Scoped Coordinator Role

This plan details the implementation of access scoping for cooperative coordinators (e.g. `temicord@oriyon.ng`). When coordinators log in, they will only see cooperative members belonging to their assigned Local Government Area (LGA) (e.g. `Ibadan North`), keeping stats, tables, and dashboards restricted to their territory.

---

## User Review Required

> [!IMPORTANT]
> **Super-Admin Permissions:**
> Users with the `'admin'` role will continue to see all cooperative members across all states and LGAs without restrictions.
> Users with the `'coordinator'` role will be constrained to the specific LGA configured in their profile.

---

## Proposed Changes

### 1. Database Schema Enhancements

#### [MODIFY] [schema.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/auth-service/src/db/schema.ts) (auth-service)
- Add assigned scope columns to the `auth_users` table:
  - `assignedState: varchar("assigned_state", { length: 100 })` (nullable)
  - `assignedLga: varchar("assigned_lga", { length: 100 })` (nullable)
- Generate database migrations for `auth-service` via `npm run db:generate`.
- Apply migrations via `npm run db:migrate`.

#### [MODIFY] [schema.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/user-service/src/db/schema.ts) (user-service)
- Update `roleEnum` definition to include `"coordinator"`:
  `export const roleEnum = pgEnum("role", ["trainee", "trainer", "coordinator", "admin"]);`
- Add assigned scope columns to the `users` table:
  - `assignedState: varchar("assigned_state", { length: 100 })` (nullable)
  - `assignedLga: varchar("assigned_lga", { length: 100 })` (nullable)
- Generate database migrations for `user-service` via `npm run db:generate`.
- Apply migrations via `npm run db:migrate`.

---

### 2. Authentication and Token Upgrades

#### [MODIFY] [auth.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/auth-service/src/routes/auth.ts) (auth-service)
- Update `generateAccessToken` payload signature to fetch and embed `assignedLga` and `assignedState` in JWT claims:
  ```typescript
  function generateAccessToken(user: { id: string; email: string; role: string; assignedLga?: string | null; assignedState?: string | null }) {
    return jwt.sign(
      { userId: user.id, email: user.email, role: user.role, assignedLga: user.assignedLga, assignedState: user.assignedState },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || "15m") as any }
    );
  }
  ```

---

### 3. API Gateway Header Delegation

#### [MODIFY] [auth.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/api-gateway/src/middleware/auth.ts) (api-gateway)
- Update the `JwtPayload` interface to support `"coordinator"` role and scope properties:
  ```typescript
  interface JwtPayload {
    userId: string;
    email: string;
    role: "trainee" | "trainer" | "coordinator" | "admin";
    assignedLga?: string | null;
    assignedState?: string | null;
  }
  ```
- Update `authenticate` middleware to inject scope claims into request headers:
  ```typescript
  req.headers["x-user-assigned-lga"] = payload.assignedLga || "";
  req.headers["x-user-assigned-state"] = payload.assignedState || "";
  ```
- Allow `"coordinator"` in `requireRole`.

#### [MODIFY] [index.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/api-gateway/src/index.ts) (api-gateway)
- Update the cooperative routes list to allow `coordinator` role access in `requireRole` configuration:
  - `GET /api/cooperative/members` $\rightarrow$ `requireRole("admin", "coordinator")`
  - `GET /api/cooperative/members/status/:status` $\rightarrow$ `requireRole("admin", "coordinator")`
  - `GET /api/cooperative/members/:id` $\rightarrow$ `requireRole("admin", "coordinator")`
  - `GET /api/cooperative/by-application/:applicationId` $\rightarrow$ `requireRole("admin", "coordinator")`
  - `PATCH /api/cooperative/members/:id` $\rightarrow$ `requireRole("admin", "coordinator")`
  - `GET /api/cooperative/stats` $\rightarrow$ `requireRole("admin", "coordinator")`

---

### 4. Downstream API Query Scoping

#### [MODIFY] [cooperative.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/applications-service/src/routes/cooperative.ts) (applications-service)
- Update `GET /members`, `GET /members/status/:status`, and `GET /stats` routes:
  - Intercept the incoming headers: `x-user-role` and `x-user-assigned-lga`.
  - If the role is `"coordinator"`, automatically apply `where(eq(cooperativeMembers.lga, assignedLga))` to the database queries.

---

### 5. Seeding Configuration

#### [MODIFY] [seed-coordinator.ts](file:///Users/themydee/Desktop/Oriyon/oriyon-backend/services/auth-service/src/seed-coordinator.ts)
- Update the coordinator seeding script to set the user role to `'coordinator'` and assign them `'Oyo State'` and `'Ibadan North'`.

---

## Verification Plan

### Automated Tests
- Run TS build tests for:
  - `user-service`
  - `auth-service`
  - `api-gateway`
  - `applications-service`

### Manual Verification
1. Run coordinator seeding using the updated `seed-coordinator.ts` script.
2. Log in as `temicord@oriyon.ng`.
3. Check the returned JWT payload to verify it contains `role: "coordinator"` and `assignedLga: "Ibadan North"`.
4. Call `GET /api/cooperative/members` using the coordinator token and verify only members with `lga = "Ibadan North"` are returned.
