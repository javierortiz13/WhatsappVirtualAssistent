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

/**
 * `pg` (el driver de pg-boss) reconstruye el SSL a partir de `sslmode` en la URL y pisa las opciones.
 * Para pg-boss se quita `sslmode` de la cadena y se pasa el SSL explícito: con CA configurada,
 * verificación completa; sin CA pero con sslmode, cifrado sin verificar (mismo comportamiento que
 * postgres.js con `require`); sin sslmode, sin TLS (Postgres local).
 */
export function pgConnection(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): { connectionString: string; ssl?: object } {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const ca = sslFromEnv(env);
  const ssl = ca ? ca : mode && mode !== "disable" ? { rejectUnauthorized: false } : undefined;
  return { connectionString: u.toString(), ...(ssl ? { ssl } : {}) };
}
