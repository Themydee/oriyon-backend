#!/bin/bash

# Terminate all background processes on exit
trap 'kill $(jobs -p)' EXIT

echo "================================================="
echo "Starting Oriyon Microservices on localhost..."
echo "================================================="

# Start services and log to respective files
(cd services/auth-service && npm run dev > ../../auth.log 2>&1) &
echo "✔ Started auth-service on http://localhost:3001"

(cd services/user-service && npm run dev > ../../user.log 2>&1) &
echo "✔ Started user-service on http://localhost:3002"

(cd services/lms-service && npm run dev > ../../lms.log 2>&1) &
echo "✔ Started lms-service on http://localhost:3003"

(cd services/applications-service && npm run dev > ../../applications.log 2>&1) &
echo "✔ Started applications-service on http://localhost:3004"

(cd services/notifications-service && npm run dev > ../../notifications.log 2>&1) &
echo "✔ Started notifications-service on http://localhost:3005"

(cd services/shop-service && npm run dev > ../../shop.log 2>&1) &
echo "✔ Started shop-service on http://localhost:3006"

# Pause briefly for microservices to bind ports before starting Gateway
sleep 2

(cd services/api-gateway && npm run dev > ../../gateway.log 2>&1) &
echo "✔ Started api-gateway on http://localhost:3000"

echo "================================================="
echo "All microservices are active!"
echo "Interactive Swagger UI: http://localhost:3000/api-docs"
echo "Press Ctrl+C to stop all services."
echo "================================================="

# Keep script running to capture Ctrl+C
wait
