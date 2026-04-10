# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/auth-service/package*.json ./
RUN npm ci

COPY services/auth-service/tsconfig.base.json ./
COPY services/auth-service/tsconfig.json ./
COPY services/auth-service/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/auth-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY services/auth-service/src/db/migrations ./dist/db/migrations

EXPOSE 3001

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]