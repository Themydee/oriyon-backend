# Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/api-gateway/package*.json ./
RUN npm ci

COPY services/api-gateway/tsconfig.base.json ./
COPY services/api-gateway/tsconfig.json ./
COPY services/api-gateway/src ./src

RUN npm run build

# Runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/api-gateway/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
