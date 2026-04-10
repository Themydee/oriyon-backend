import "dotenv/config";
import { defineConfig } from "drizzle-kit";
export default defineConfig({
    schema: "./services/auth-service/src/db/schema.ts",
    out: "./services/auth-service/src/db/migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL,
    },
    verbose: true,
    strict: true,
});
