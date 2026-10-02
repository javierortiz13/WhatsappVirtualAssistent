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
  /** Solo servidor: firma URLs de las fotos de facturas en el bucket privado. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  STORAGE_BUCKET: z.string().default("receipts"),
  PLATFORM_WA_NUMBER: z
    .string()
    .regex(/^\d{8,15}$/)
    .optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Correos con acceso al panel /admin, separados por coma. Sin esto, nadie entra. */
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
  /**
   * Datos para cobrar que ve el cliente en "Mi plan" (ADR-015). Texto libre, por ejemplo
   * "Banesco · 0412 1234567 · V-12345678". Sin ellos, la página le pide escribir a soporte.
   */
  PAYMENT_PAGO_MOVIL: z.string().optional(),
  PAYMENT_ZELLE: z.string().optional(),
  PAYMENT_BINANCE: z.string().optional(),
  /** Contacto de soporte para el cliente (mismo valor que SUPPORT_HINT del worker). */
  SUPPORT_HINT: z.string().optional(),
  /** Tarifa de Meta por mensaje de servicio fuera del cupo gratis (ADR-014). */
  META_MSG_RATE_USD: z.coerce.number().default(0.0113),
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
