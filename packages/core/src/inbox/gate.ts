import { and, eq, gt, gte, schema, sql, type Tx } from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { prefState } from "./prefs";
import { serviceWindow } from "./window";

/**
 * La puerta de todo lo que Rocco manda por su cuenta (PRD hábitos US-203, §5). Un solo lugar con
 * todas las reglas; quien llama escribe la marca antes de mandar (marca, confirma, envía).
 *
 * - `reminder_a`: el recordatorio a su hora. Lo pidió la persona: no gasta el cupo del día
 *   (máximo 3 al día, A6) y no lo frena `nudges_off` (F2-3), ni el horario nocturno (va a la hora
 *   pedida). Sí lo frena «no me escribas», también pendiente (D10).
 * - `reminder_b` (aviso adelantado), `reminder_d` (plantilla) y `nudge` (8 pm): gastan el cupo de
 *   uno al día y los frena cualquier apagado, también pendiente.
 */
export type UnsolicitedKind = "nudge" | "reminder_a" | "reminder_b" | "reminder_d";

export type GateDeny =
  | "window_closed"
  | "quiet_hours"
  | "tenant_blocked"
  | "slot_taken"
  | "failed_recent"
  | "opted_out"
  | "pending_opt_out"
  | "not_opted_in"
  | "paused"
  | "lifecycle_today"
  | "daily_cap";

export type GateResult = { allow: true } | { allow: false; reason: GateDeny };

/** Marcas de lo que gasta el cupo de un mensaje por cuenta propia al día (§5 item 1). */
export const SLOT_MARKS = [
  "lifecycle_survey",
  "lifecycle_value",
  "lifecycle_trial_end",
  "notice_payment",
  "notice_retention",
  "habit_nudge",
  "reminder_b",
  "reminder_d",
] as const;
const LIFECYCLE_MARKS = ["lifecycle_survey", "lifecycle_value", "lifecycle_trial_end"] as const;

/** Máximo de recordatorios a su hora por teléfono al día (A6). */
export const REMINDER_A_PER_DAY = 3;

/** Horario nocturno (§5 item 6): de 20:31 a 07:59 de Caracas, nada por cuenta propia. */
export function isQuietHours(now: Date): boolean {
  const caracas = new Date(now.getTime() - 4 * 3_600_000);
  const minutes = caracas.getUTCHours() * 60 + caracas.getUTCMinutes();
  return minutes >= 20 * 60 + 31 || minutes < 8 * 60;
}

/** Inicio del día de Caracas de `now`, como instante. */
export function caracasDayStart(now: Date): Date {
  return new Date(`${businessDateOf(now)}T04:00:00Z`);
}

/** Salientes de hoy con alguna de estas marcas (una vez por turno, N-3). */
async function marksToday(
  tx: Tx,
  phoneId: string,
  names: readonly string[],
  now: Date,
): Promise<number> {
  const any = sql.join(
    names.map((n) => sql`${schema.message.toolCalls} @> ${JSON.stringify([{ name: n }])}::jsonb`),
    sql` or `,
  );
  const [r] = await tx
    .select({
      n: sql<number>`count(distinct coalesce(${schema.message.webhookEventId}, ${schema.message.id}))::int`,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        gte(schema.message.createdAt, caracasDayStart(now)),
        sql`(${any})`,
      ),
    );
  return r?.n ?? 0;
}

/** ¿Un envío a este teléfono falló en los últimos 7 días? (§5 item 7: bloqueo o reporte posible.) */
async function failedRecently(tx: Tx, phoneId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [sent] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        eq(schema.message.status, "failed"),
        gt(schema.message.createdAt, since),
      ),
    )
    .limit(1);
  if (sent) return true;
  // Estados "failed" que Meta mandó después de aceptar el envío (`ingest.ts`).
  const [status] = await tx
    .select({ id: schema.webhookEvent.id })
    .from(schema.webhookEvent)
    .innerJoin(
      schema.message,
      sql`${schema.message.waMessageId} = ${schema.webhookEvent.payload}->>'waMessageId'`,
    )
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        sql`${schema.webhookEvent.eventKey} like 'status:%:failed'`,
        gt(schema.webhookEvent.receivedAt, since),
      ),
    )
    .limit(1);
  return Boolean(status);
}

export type GateInput = {
  tenantId: string;
  phoneId: string;
  kind: UnsolicitedKind;
  now: Date;
  /** Negocio suspendido, borrado, o sin mensajes (prueba o mes en su tope). */
  tenantBlocked: boolean;
  /** Un aviso del ciclo de la prueba sale hoy (además de los ya mandados). */
  lifecycleDueToday?: boolean;
};

export async function takeUnsolicitedSlot(tx: Tx, g: GateInput): Promise<GateResult> {
  const deny = (reason: GateDeny): GateResult => ({ allow: false, reason });
  if (g.tenantBlocked) return deny("tenant_blocked");
  // La plantilla (camino d) es justamente para cuando la ventana está cerrada.
  if (g.kind !== "reminder_d" && !(await serviceWindow(tx, g.phoneId, g.now)).open)
    return deny("window_closed");
  if (g.kind !== "reminder_a" && isQuietHours(g.now)) return deny("quiet_hours");
  const s = await prefState(tx, g.phoneId, g.tenantId);
  if (g.kind === "reminder_a") {
    if (s.unsolicitedOffAt || s.tagged) return deny("opted_out");
    if (s.prefPending === "all_off") return deny("pending_opt_out");
  } else {
    if (s.nudgeOffAt || s.unsolicitedOffAt || s.tagged) return deny("opted_out");
    if (s.prefPending) return deny("pending_opt_out");
  }
  if (g.kind === "nudge") {
    if (!s.nudgeOptInAt) return deny("not_opted_in");
    if (s.nudgePausedUntil && s.nudgePausedUntil.getTime() > g.now.getTime()) return deny("paused");
  }
  if (await failedRecently(tx, g.phoneId, g.now)) return deny("failed_recent");
  if (g.kind === "reminder_a") {
    if ((await marksToday(tx, g.phoneId, ["reminder_a"], g.now)) >= REMINDER_A_PER_DAY)
      return deny("daily_cap");
    return { allow: true };
  }
  if (await marksToday(tx, g.phoneId, SLOT_MARKS, g.now)) return deny("slot_taken");
  if (
    (g.kind === "nudge" || g.kind === "reminder_b") &&
    (g.lifecycleDueToday || (await marksToday(tx, g.phoneId, LIFECYCLE_MARKS, g.now)))
  )
    return deny("lifecycle_today");
  return { allow: true };
}
