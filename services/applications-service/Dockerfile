# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/applications-service/package*.json ./
RUN npm ci

COPY services/applications-service/tsconfig.base.json ./
COPY services/applications-service/tsconfig.json ./
COPY services/applications-service/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/applications-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY services/applications-service/src/db/migrations ./dist/db/migrations

EXPOSE 3004
CMD node dist/db/migrate.js && node dist/index.js
