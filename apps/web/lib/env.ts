import "server-only";
import { z } from "zod";

/** Variables de entorno del servidor web. Se validan en el primer uso y fallan rápido. */
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(16),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
  /** Número de WhatsApp de la plataforma (E.164 sin '+') para el enlace wa.me del onboarding. */
  PLATFORM_WA_NUMBER: z
    .string()
    .regex(/^\d{8,15}$/)
    .optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type WebEnv = z.infer<typeof Env>;

let cached: WebEnv | null = null;

export function env(): WebEnv {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`variables de entorno inválidas: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
