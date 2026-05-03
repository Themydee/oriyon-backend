FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.base.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations

EXPOSE 3005
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]