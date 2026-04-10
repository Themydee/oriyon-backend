# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/user-service/package*.json ./
RUN npm ci

COPY services/user-service/tsconfig.base.json ./
COPY services/user-service/tsconfig.json ./
COPY services/user-service/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/user-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY services/user-service/src/db/migrations ./dist/db/migrations

EXPOSE 3002
CMD node dist/db/migrate.js && node dist/index.js
