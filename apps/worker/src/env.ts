import { loadNearestEnvFile } from "@caja/db";
import { z } from "zod";

/** Variables de entorno del worker, validadas al arrancar. Falla rápido si falta algo. */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ASSISTANT_NAME: z.string().default("Asistente de Caja"),
  DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
  SUPPORT_HINT: z.string().optional(),
  /** Datos de cobro que el bot manda al renovar el plan (mismos valores que en Vercel). */
  PAYMENT_PAGO_MOVIL: z.string().optional(),
  PAYMENT_ZELLE: z.string().optional(),
  PAYMENT_BINANCE: z.string().optional(),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_GRAPH_VERSION: z.string().default("v24.0"),
  /** Plantilla de WhatsApp para avisar de borrado por impago fuera de las 24 h (0017). */
  META_RETENTION_TEMPLATE: z.string().optional(),
  META_TEMPLATE_LANGUAGE: z.string().default("es"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_PRIMARY: z.string().default("anthropic:claude-sonnet-5-5"),
  /** TTL del caché del prompt de Anthropic. "5m" vuelve al caché corto sin cambiar código. */
  LLM_CACHE_TTL: z.enum(["5m", "1h"]).default("1h"),
  SENTRY_DSN: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  /** Bucket privado de fotos (US-B6). Sin estas dos, las fotos se leen pero no se guardan. */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  STORAGE_BUCKET: z.string().default("receipts"),
  DEEPGRAM_LANGUAGE: z.string().default("es"),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) loadNearestEnvFile();
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`variables de entorno inválidas: ${issues}`);
  }
  return parsed.data;
}
