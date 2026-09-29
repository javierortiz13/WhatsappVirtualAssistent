import { z } from "zod";

/** Variables de entorno del worker, validadas al arrancar. Falla rápido si falta algo. */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ASSISTANT_NAME: z.string().default("Asistente de Caja"),
  DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
  SUPPORT_HINT: z.string().optional(),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_GRAPH_VERSION: z.string().default("v24.0"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`variables de entorno inválidas: ${issues}`);
  }
  return parsed.data;
}
