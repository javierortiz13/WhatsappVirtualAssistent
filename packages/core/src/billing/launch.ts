import { eq, type Queryable, schema, type Tx } from "@caja/db";
import { BETA, TRIAL_DAYS } from "./plans";
import { subscriptionState } from "./subscription";
import { trialSpend } from "./trial";

/**
 * Modo de lanzamiento (0021, decisión de Javier del 07/10/2026), en `app.app_setting` y editable
 * en /admin sin redesplegar:
 * - beta: durante la prueba gratis Rocco no da precios ni cobra; a "renovar", "recargar" o "¿cuántos
 *   mensajes me quedan?" responde los días y los mensajes que quedan. Al terminar la prueba (por
 *   días o por mensajes) sí muestra los precios y cómo pagar.
 * - live: los precios se muestran siempre, como en un plan pagado.
 * También los días de la encuesta de precio y del resumen de la prueba.
 */
export type LaunchSettings = { beta: boolean; surveyDay: number; valueDay: number };

export const LAUNCH_DEFAULTS: LaunchSettings = { beta: BETA, surveyDay: 10, valueDay: 12 };
const KEY = "launch";

const day = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v < TRIAL_DAYS ? v : fallback;

/** Ajustes vigentes; sin fila (o con datos raros) quedan los valores por defecto. */
export async function launchSettings(db: Queryable): Promise<LaunchSettings> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  return {
    beta: typeof v.beta === "boolean" ? v.beta : LAUNCH_DEFAULTS.beta,
    surveyDay: day(v.surveyDay, LAUNCH_DEFAULTS.surveyDay),
    valueDay: day(v.valueDay, LAUNCH_DEFAULTS.valueDay),
  };
}

export async function saveLaunchSettings(
  db: Queryable,
  next: LaunchSettings,
  actor: string,
  now: Date,
): Promise<void> {
  const value = {
    beta: next.beta,
    surveyDay: day(next.surveyDay, LAUNCH_DEFAULTS.surveyDay),
    valueDay: day(next.valueDay, LAUNCH_DEFAULTS.valueDay),
  };
  await db
    .insert(schema.appSetting)
    .values({ key: KEY, value, updatedAt: now, updatedBy: actor })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: actor },
    });
}

export type BetaTrial = {
  endsAt: Date | null;
  daysLeft: number | null;
  messages: number;
  messageCap: number;
};

/**
 * En beta y con la prueba en curso (le quedan días y mensajes): lo que le queda. Si no, null y
 * Rocco muestra los precios como siempre.
 */
export async function betaTrialStatus(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<BetaTrial | null> {
  if (!(await launchSettings(tx)).beta) return null;
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (t?.status !== "trial" || t.deletedAt) return null;
  const state = subscriptionState(t, now);
  if (state.kind !== "trial") return null;
  const spend = await trialSpend(tx, t);
  if (spend.reached) return null;
  return {
    endsAt: state.endsAt,
    daysLeft: state.daysLeft,
    messages: Math.min(spend.messages, spend.messageCap),
    messageCap: spend.messageCap,
  };
}
