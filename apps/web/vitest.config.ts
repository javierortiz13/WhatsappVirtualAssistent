import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Las vistas del admin se prueban renderizadas (A-2, 19/11).
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@/": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { name: "web", include: ["test/**/*.test.{ts,tsx}"], passWithNoTests: true },
});
