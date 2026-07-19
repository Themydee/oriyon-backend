#!/bin/bash

# Terminate all background processes on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "================================================="
echo "Oriyon Local Setup & Runtime Automator"
echo "================================================="

# 1. VERIFY PRE-REQUISITES
echo "Checking dependencies..."

if ! command -v pg_isready &> /dev/null; then
  echo "⚠ Postgres CLI (pg_isready) is not on your PATH. Please make sure Postgres is running."
else
  if ! pg_isready -h localhost -p 5432 &> /dev/null; then
    echo "❌ Postgres is not running on port 5432. Please start it using 'brew services start postgresql@16'."
    exit 1
  fi
fi

# 2. CREATE ROOT & SERVICE .env FILES
echo "Configuring environment variables..."

# Root .env
if [ ! -f .env ]; then
  cat <<EOT > .env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
RABBITMQ_USER=guest
RABBITMQ_PASS=guest
JWT_SECRET=oriyon-secret-key-2026-qa-test
JWT_REFRESH_SECRET=oriyon-refresh-secret-key-2026-qa-test
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:3000
RESEND_API_KEY=re_8c6tiTMh_SMCL595AHtgAktyzvc1cUxEi
EMAIL_FROM=no-reply@oriyoninternational.com
EOT
  echo "✔ Created root .env"
fi

# Service-specific env setups
create_env_if_missing() {
  local file_path=$1
  local content=$2
  if [ ! -f "$file_path" ]; then
    echo "$content" > "$file_path"
    echo "✔ Created $file_path"
  fi
}

create_env_if_missing "services/api-gateway/.env" "PORT=3000
JWT_SECRET=oriyon-secret-key-2026-qa-test
JWT_REFRESH_SECRET=oriyon-refresh-secret-key-2026-qa-test
AUTH_SERVICE_URL=http://localhost:3001
USER_SERVICE_URL=http://localhost:3002
LMS_SERVICE_URL=http://localhost:3003
APPLICATIONS_SERVICE_URL=http://localhost:3004
NOTIFICATIONS_SERVICE_URL=http://localhost:3005
SHOP_SERVICE_URL=http://localhost:3006"

create_env_if_missing "services/auth-service/.env" "PORT=3001
DATABASE_URL=postgres://localhost:5432/oriyon_auth
JWT_SECRET=oriyon-secret-key-2026-qa-test
JWT_REFRESH_SECRET=oriyon-refresh-secret-key-2026-qa-test
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:3000
RABBITMQ_URL=amqp://localhost:5672
USER_DATABASE_URL=postgres://localhost:5432/oriyon_user"

create_env_if_missing "services/user-service/.env" "PORT=3002
DATABASE_URL=postgres://localhost:5432/oriyon_user
JWT_SECRET=oriyon-secret-key-2026-qa-test
RABBITMQ_URL=amqp://localhost:5672
LMS_SERVICE_URL=http://localhost:3003"

create_env_if_missing "services/lms-service/.env" "PORT=3003
DATABASE_URL=postgres://localhost:5432/oriyon_lms
JWT_SECRET=oriyon-secret-key-2026-qa-test
RABBITMQ_URL=amqp://localhost:5672
USER_SERVICE_URL=http://localhost:3002"

create_env_if_missing "services/applications-service/.env" "PORT=3004
DATABASE_URL=postgres://localhost:5432/oriyon_applications
JWT_SECRET=oriyon-secret-key-2026-qa-test
RABBITMQ_URL=amqp://localhost:5672"

create_env_if_missing "services/notifications-service/.env" "PORT=3005
DATABASE_URL=postgres://localhost:5432/oriyon_notifications
JWT_SECRET=oriyon-secret-key-2026-qa-test
RABBITMQ_URL=amqp://localhost:5672
RESEND_API_KEY=re_8c6tiTMh_SMCL595AHtgAktyzvc1cUxEi
EMAIL_FROM=no-reply@oriyoninternational.com
FRONTEND_URL=http://localhost:3000"

# 3. CREATE DATABASES IF MISSING
echo "Ensuring databases exist..."
for db in oriyon_auth oriyon_user oriyon_lms oriyon_applications oriyon_notifications oriyon_shop; do
  createdb "$db" 2>/dev/null && echo "✔ Created database: $db" || echo "✔ Database $db already exists"
done

# 4. INSTALL DEPENDENCIES IF MISSING
echo "Ensuring node_modules are installed..."
for dir in services/*; do
  if [ -d "$dir" ]; then
    if [ ! -d "$dir/node_modules" ]; then
      echo "Installing dependencies in $dir..."
      (cd "$dir" && npm install)
    else
      echo "✔ Dependencies already installed in $dir"
    fi
  fi
done

# 5. CLEAN UP STALE TS COMPILATIONS IN AUTH-SERVICE
echo "Checking for stale JS assets..."
find services/auth-service/src -name "*.js" -delete 2>/dev/null

# 6. RUN MIGRATIONS
echo "Running database migrations..."
for service in auth-service user-service lms-service applications-service notifications-service shop-service; do
  echo "Migrating $service..."
  (cd "services/$service" && npm run migrate)
done

# 7. SEED ADMIN USER
echo "Checking admin account seeding..."
(cd services/auth-service && npx ts-node src/seed-admin.ts)

echo "Seeding coordinators..."
(cd services/auth-service && npx ts-node src/seed-coordinator.ts)

echo "Checking trainer account seeding..."
(cd services/auth-service && npx ts-node src/seed-trainer.ts)

echo "Seeding shop products..."
(cd services/shop-service && npm run db:seed)

# 8. LAUNCH STACK
echo "================================================="
echo "Launching all microservices..."
echo "================================================="

(cd services/auth-service && npm run dev > ../../auth.log 2>&1) &
echo "🚀 Started auth-service on http://localhost:3001"

(cd services/user-service && npm run dev > ../../user.log 2>&1) &
echo "🚀 Started user-service on http://localhost:3002"

(cd services/lms-service && npm run dev > ../../lms.log 2>&1) &
echo "🚀 Started lms-service on http://localhost:3003"

(cd services/applications-service && npm run dev > ../../applications.log 2>&1) &
echo "🚀 Started applications-service on http://localhost:3004"

(cd services/notifications-service && npm run dev > ../../notifications.log 2>&1) &
echo "🚀 Started notifications-service on http://localhost:3005"

(cd services/shop-service && npm run dev > ../../shop.log 2>&1) &
echo "🚀 Started shop-service on http://localhost:3006"

# Allow backend services to bind ports before starting API Gateway
sleep 2

(cd services/api-gateway && npm run dev > ../../gateway.log 2>&1) &
echo "🚀 Started api-gateway on http://localhost:3000"

echo "================================================="
echo "Setup complete! All services are active."
echo "Interactive Swagger UI: http://localhost:3000/api-docs"
echo "Log files created in root directory (*.log)."
echo "Press Ctrl+C to stop all services."
echo "================================================="

# Wait for background jobs
wait
