import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@/…` como en tsconfig, para probar rutas que lo importan (/api/ref).
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { name: "web", include: ["test/**/*.test.ts"], passWithNoTests: true },
});
