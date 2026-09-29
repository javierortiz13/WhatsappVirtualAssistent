import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { envFileDir } from "./env-file.js";

/**
 * Supabase firma sus certificados con una CA propia. Para mantener la verificación TLS completa
 * (Fase 7) se pasa esa CA a los drivers en lugar de desactivar la verificación.
 * - `DATABASE_SSL_CA_PATH`: ruta al .crt descargado de Supabase (desarrollo local).
 * - `DATABASE_SSL_CA`: el PEM completo en una variable (Railway y Vercel, donde no hay archivos).
 * Sin ninguna de las dos, el driver usa su comportamiento por defecto según la URL.
 */
export type SslConfig = { ca: string; rejectUnauthorized: true } | undefined;

export function sslFromEnv(env: NodeJS.ProcessEnv = process.env): SslConfig {
  const inline = env.DATABASE_SSL_CA?.trim();
  if (inline) return { ca: inline.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  const path = env.DATABASE_SSL_CA_PATH?.trim();
  if (path) {
    // `pnpm --filter` corre dentro del paquete: una ruta relativa se resuelve desde la raíz (donde está el .env).
    const full = isAbsolute(path) ? path : resolve(envFileDir() ?? process.cwd(), path);
    return { ca: readFileSync(full, "utf8"), rejectUnauthorized: true };
  }
  return undefined;
}
