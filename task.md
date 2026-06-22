# Task Board - LGA-Scoped Coordinator Role

- `[x]` **Phase 1: Database Schema Modifications**
  - `[x]` Modify `schema.ts` in `auth-service` (add `assignedState` and `assignedLga` columns)
  - `[x]` Modify `schema.ts` in `user-service` (add `coordinator` role and `assignedState`/`assignedLga` columns)
  - `[x]` Generate database migrations for `auth-service` and `user-service`
  - `[x]` Apply migrations for both services
- `[ ]` **Phase 2: Authentication and Token Setup**
  - `[ ]` Update JWT `generateAccessToken` payload signature in `auth-service`'s `routes/auth.ts`
  - `[ ]` Update coordinator seeding script `seed-coordinator.ts` with correct role and LGA assignment scope
- `[ ]` **Phase 3: API Gateway Scope Delegation**
  - `[ ]` Update `JwtPayload` interface and `authenticate` header forwarding in gateway's `middleware/auth.ts`
  - `[ ]` Configure gateway's routes in `index.ts` to allow `coordinator` role for cooperative member endpoints
- `[ ]` **Phase 4: Downstream API Query Scoping**
  - `[ ]` Update member fetch endpoints in `applications-service`'s `routes/cooperative.ts` to apply assigned LGA restrictions
- `[ ]` **Phase 5: Verification & Testing**
  - `[ ]` Rebuild all services
  - `[ ]` Run coordinator seeding script
  - `[ ]` Test token contents and verify LGA-scoped member fetching
