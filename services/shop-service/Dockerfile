FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json tsconfig.base.json ./
COPY services/shop-service/package*.json ./services/shop-service/
RUN npm ci
COPY services/shop-service ./services/shop-service
COPY tsconfig.base.json ./
RUN npm run build -w services/shop-service

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/services/shop-service/package*.json ./services/shop-service/
RUN npm ci --omit=dev
COPY --from=builder /app/services/shop-service/dist ./services/shop-service/dist
EXPOSE 3006
CMD ["node", "services/shop-service/dist/index.js"]
