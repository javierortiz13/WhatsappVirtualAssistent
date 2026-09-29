import { z } from "zod";

/** Variables de entorno del worker, validadas al arrancar. Falla rápido si falta algo. */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ASSISTANT_NAME: z.string().default("Asistente de Caja"),
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
