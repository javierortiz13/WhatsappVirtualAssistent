import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Carga el `.env` más cercano subiendo desde el directorio actual (la raíz del monorepo en la
 * práctica) con `process.loadEnvFile` de Node 22. No pisa variables ya definidas en el entorno,
 * así que en Railway y Vercel no hace nada. Silencioso si no existe.
 */
export function loadNearestEnvFile(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const before = { ...process.env };
      process.loadEnvFile(candidate);
      // loadEnvFile no sobrescribe, pero por si acaso restauramos lo que ya existía.
      for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
