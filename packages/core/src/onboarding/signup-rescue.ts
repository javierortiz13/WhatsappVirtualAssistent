import { createHash } from "node:crypto";
import { and, type Db, eq, isNull, type Queryable, schema, sql } from "@caja/db";
import { isQuietHours } from "../inbox/gate";
import { windowOpenAt } from "../inbox/window";
import { type Logger, maskPhone, silentLogger } from "../log";
import type { SignupRescueStep } from "../render/es-VE";
import { es } from "../render/index";
import { MetaApiError, type MetaClient } from "../whatsapp/client";
import { remainingSteps, SIGNUP_STEPS, type SignupData, type SignupStep } from "./chat-signup";
import { bumpSignupCounts } from "./signup-counts";

/**
 * Recordatorios del registro por WhatsApp (PRD signup-reminders v1.2). Un mensaje automático por
 * persona en la vida: (A) en la ventana de 24 h, 3 h después de su último mensaje, o (B) la
 * plantilla de un solo lote (CLI `signup:rescue`), o nada (grupo de control). `rescue_via` es
 * compartido y se marca antes de enviar, con una actualización condicional.
 *
 * Nunca van al log nombres, números sin enmascarar ni texto.
 */

/** (A) sale 3 h después del último mensaje sin responder (decisión 1A). */
export const SIGNUP_RESCUE_AFTER_MS = 3 * 3_600_000;

/** Payloads de los botones de la plantilla (B), en el orden de la plantilla aprobada. */
export const SIGNUP_RESCUE_PAYLOADS = ["signup:resume", "signup:stop"];

// ---------------------------------------------------------------- interruptores

export type SignupRescueSettings = {
  /** (A) en la ventana. */
  inWindow: boolean;
  /** (B) el lote: el CLI se niega sin esto y se para si se apaga a mitad (S1). */
  template: boolean;
  /** (A) como texto libre ("text") o como la plantilla aprobada ("template", CF-1). */
  inWindowVia: "text" | "template";
  /** Grupo de control de (A), por ciento (20 hasta la lectura). */
  holdoutPct: number;
  /** Desde cuándo está encendido (A): lo de antes es del lote (B). ISO o null. */
  inWindowSince: string | null;
};

export const SIGNUP_RESCUE_DEFAULTS: SignupRescueSettings = {
  inWindow: false,
  template: false,
  inWindowVia: "text",
  holdoutPct: 20,
  inWindowSince: null,
};
const KEY = "signup_rescue";

export async function signupRescueSettings(db: Queryable): Promise<SignupRescueSettings> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  const pct = Number(v.holdoutPct);
  return {
    inWindow: v.inWindow === true,
    template: v.template === true,
    inWindowVia: v.inWindowVia === "template" ? "template" : "text",
    holdoutPct:
      Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : SIGNUP_RESCUE_DEFAULTS.holdoutPct,
    inWindowSince: typeof v.inWindowSince === "string" ? v.inWindowSince : null,
  };
}

/** Encender (A) guarda `inWindowSince = now`; apagarlo no lo borra (las métricas lo usan). */
export async function saveSignupRescueSettings(
  db: Queryable,
  next: Partial<Omit<SignupRescueSettings, "inWindowSince">>,
  actor: string,
  now: Date,
): Promise<SignupRescueSettings> {
  const current = await signupRescueSettings(db);
  const value: SignupRescueSettings = { ...current, ...next };
  if (next.inWindow === true && !current.inWindow) value.inWindowSince = now.toISOString();
  await db
    .insert(schema.appSetting)
    .values({ key: KEY, value, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: actor },
    });
  return value;
}

// ---------------------------------------------------------------- grupo de control y texto

/** Determinista sobre `signup.id`: la misma fila cae siempre en el mismo grupo. */
export function inHoldout(signupId: string, pct: number): boolean {
  if (pct <= 0) return false;
  const h = createHash("sha256").update(signupId).digest();
  return h.readUInt32BE(0) % 100 < pct;
}

/** SR-A1…A4 según el paso, con el nombre que dio (sin él, «Hola.»). */
export function rescueMessage(step: SignupStep, data: SignupData) {
  const s = (step === "done" ? "budget" : step) as SignupRescueStep;
  return es.signupRescue(s, data.name ?? null, remainingSteps(step, data));
}

/** El paso guardado, o "name" si no es uno conocido. */
export function stepOf(raw: string): SignupStep {
  return (SIGNUP_STEPS as readonly string[]).includes(raw) ? (raw as SignupStep) : "name";
}

// ---------------------------------------------------------------- (A) el job

export type SignupRescueRun = {
  sent: number;
  holdout: number;
  failed: number;
  /** Por código de Meta (o "otro"), solo cuentas. */
  failedByCode: Record<string, number>;
  /** Corrida dentro del horario nocturno: no se miró nada. */
  quiet: boolean;
};

/** Marca condicional: solo si nadie escribió ni la marcó en el medio. */
async function claim(
  db: Db,
  id: string,
  seen: Date,
  via: "window" | "template" | "holdout",
  now: Date,
): Promise<boolean> {
  const s = schema.signup;
  const r = await db
    .update(s)
    .set({ rescueAt: now, rescueVia: via })
    .where(
      and(
        eq(s.id, id),
        isNull(s.rescueVia),
        isNull(s.contactOffAt),
        isNull(s.founderContactedAt),
        isNull(s.completedAt),
        // CC-1: el primer mensaje guarda microsegundos (default now()) y `seen` es un Date (ms).
        sql`date_trunc('milliseconds', ${s.updatedAt}) = ${seen.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: s.id });
  return r.length > 0;
}

/** Código de Meta de un error, para contar: el número, o "otro". */
export function metaCodeOf(err: unknown): string {
  return err instanceof MetaApiError && err.code !== null ? String(err.code) : "otro";
}

/**
 * Una corrida de la cola `signup-reminders` (cada 5 min, US-SR-05). Sin `inWindow` o de noche, no
 * hace nada. Un envío que Meta rechaza deja la marca: esa persona ya usó su único mensaje.
 */
export async function runSignupRescue(
  db: Db,
  meta: MetaClient | null,
  opts: {
    now: Date;
    log?: Logger;
    /** Nombre e idioma de la plantilla aprobada, para `inWindowVia = "template"`. */
    template?: { name: string; language: string } | null;
  },
): Promise<SignupRescueRun> {
  const log = opts.log ?? silentLogger;
  const now = opts.now;
  const out: SignupRescueRun = { sent: 0, holdout: 0, failed: 0, failedByCode: {}, quiet: false };
  if (!meta) return out;
  const cfg = await signupRescueSettings(db);
  if (!cfg.inWindow) return out;
  if (isQuietHours(now)) return { ...out, quiet: true };
  if (cfg.inWindowVia === "template" && !opts.template) {
    log.warn({}, "registro: recordatorio como plantilla sin plantilla configurada");
    return out;
  }
  const s = schema.signup;
  const since = cfg.inWindowSince ? new Date(cfg.inWindowSince) : now;
  const due = new Date(now.getTime() - SIGNUP_RESCUE_AFTER_MS);
  // `phone_is_taken` (SECURITY DEFINER) cruza negocios sin abrir RLS: un número que ya es cliente.
  const rows = await db
    .select({ id: s.id, e164: s.e164, step: s.step, data: s.data, updatedAt: s.updatedAt })
    .from(s)
    .where(
      and(
        isNull(s.completedAt),
        sql`${s.step} <> 'done'`,
        isNull(s.rescueVia),
        isNull(s.contactOffAt),
        isNull(s.founderContactedAt),
        sql`${s.updatedAt} <= ${due.toISOString()}::timestamptz`,
        sql`${s.updatedAt} >= ${since.toISOString()}::timestamptz`,
        sql`not app.phone_is_taken(${s.e164})`,
      ),
    )
    .orderBy(s.updatedAt);
  for (const r of rows) {
    if (!windowOpenAt(r.updatedAt, now)) continue;
    if (inHoldout(r.id, cfg.holdoutPct)) {
      if (await claim(db, r.id, r.updatedAt, "holdout", now)) out.holdout += 1;
      continue;
    }
    if (!(await claim(db, r.id, r.updatedAt, "window", now))) continue;
    try {
      const sent =
        cfg.inWindowVia === "template" && opts.template
          ? await meta.sendTemplate(r.e164, opts.template.name, opts.template.language, [], {
              quickReplyPayloads: SIGNUP_RESCUE_PAYLOADS,
            })
          : await (() => {
              const m = rescueMessage(stepOf(r.step), (r.data ?? {}) as SignupData);
              return meta.sendButtons(r.e164, m.body, m.type === "buttons" ? m.buttons : []);
            })();
      await db.update(s).set({ rescueWaMessageId: sent.waMessageId }).where(eq(s.id, r.id));
      out.sent += 1;
      await bumpSignupCounts(db, now, {
        [cfg.inWindowVia === "template" ? "template_sends" : "sends"]: 1,
      }).catch(() => {});
    } catch (err) {
      const code = metaCodeOf(err);
      out.failed += 1;
      out.failedByCode[code] = (out.failedByCode[code] ?? 0) + 1;
      log.warn({ to: maskPhone(r.e164), code }, "registro: recordatorio no enviado");
      await bumpSignupCounts(db, now, { [`failed:${code}`]: 1 }).catch(() => {});
    }
  }
  return out;
}
