# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/notifications-service/package*.json ./
RUN npm ci

COPY services/notifications-service/tsconfig.base.json ./
COPY services/notifications-service/tsconfig.json ./
COPY services/notifications-service/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/notifications-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY services/notifications-service/src/db/migrations ./dist/db/migrations

EXPOSE 3005
CMD node dist/db/migrate.js && node dist/index.js
