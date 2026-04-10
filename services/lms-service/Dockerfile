# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/lms-service/package*.json ./
RUN npm ci

COPY services/lms-service/tsconfig.base.json ./
COPY services/lms-service/tsconfig.json ./
COPY services/lms-service/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/lms-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY services/lms-service/src/db/migrations ./dist/db/migrations

EXPOSE 3003
CMD node dist/db/migrate.js && node dist/index.js
