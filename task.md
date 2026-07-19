# Task Board - LGA-Scoped Coordinator Role

- `[x]` **Phase 1: Database Schema Modifications**
  - `[x]` Modify `schema.ts` in `auth-service` (add `assignedState` and `assignedLga` columns)
  - `[x]` Modify `schema.ts` in `user-service` (add `coordinator` role and `assignedState`/`assignedLga` columns)
  - `[x]` Generate database migrations for `auth-service` and `user-service`
  - `[x]` Apply migrations for both services
- `[x]` **Phase 2: Authentication and Token Setup**
  - `[x]` Update JWT `generateAccessToken` payload signature in `auth-service`'s `routes/auth.ts`
  - `[x]` Update coordinator seeding script `seed-coordinator.ts` with correct role and LGA assignment scope
- `[x]` **Phase 3: API Gateway Scope Delegation**
  - `[x]` Update `JwtPayload` interface and `authenticate` header forwarding in gateway's `middleware/auth.ts`
  - `[x]` Configure gateway's routes in `index.ts` to allow `coordinator` role for cooperative member endpoints
- `[x]` **Phase 4: Downstream API Query Scoping**
  - [x] Update `api-gateway/src/index.ts` to include proxy rules for the shop-service
- [x] Update root `docker-compose.yml` to support the new microservicetions
- `[x]` **Phase 5: Verification & Testing**
  - `[x]` Rebuild all services
  - `[x]` Run coordinator seeding script
  - `[x]` Test token contents and verify LGA-scoped member fetching
