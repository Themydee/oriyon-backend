FROM node:20-alpine AS builder
WORKDIR /app

COPY services/auth-service/package*.json ./
RUN npm ci

COPY tsconfig.base.json ./
COPY services/auth-service/tsconfig.json ./
COPY services/auth-service/src ./src

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY services/auth-service/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]
