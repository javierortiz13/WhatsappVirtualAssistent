import { defineConfig } from "drizzle-kit";

// Solo para `drizzle-kit check` y `drizzle-kit studio`. Las migraciones se escriben a mano en ./migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle-kit-out",
  schemaFilter: ["app"],
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "" },
});
