import {
  and,
  type Db,
  eq,
  everyTenantId,
  gte,
  isNull,
  rows,
  schema,
  sql,
  type Tx,
  withTenant,
} from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { Decimal } from "../domain/money";
import { type Logger, maskPhone, silentLogger } from "../log";
import { es, type Outbound } from "../render/index";
import type { MetaClient } from "../whatsapp/client";
import { sendOutbound } from "./process";

/**
 * Ciclo de la prueba gratis (0019, decisión de Javier del 07/10): para convertir sin presionar.
 * - Día 10: encuesta de precio (precio justo y precio caro, con listas): mide la disposición a
 *   pagar antes de fijar los precios.
 * - Día 12: resumen de lo que Rocco anotó en la prueba y "¿seguimos?" (Sí / Tengo dudas).
 * Solo dentro de la ventana de 24 h de Meta (desde el último mensaje del dueño): fuera de ella
 * haría falta una plantilla aprobada. Si no escribe, se intenta en la próxima vuelta mientras
 * siga en prueba. Las respuestas quedan en `tenant.survey` y se ven en el CRM.
 */
export const SURVEY_DAY = 10;
export const VALUE_DAY = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialValue = {
  movements: number;
  expensesUsd: Decimal;
  salesUsd: Decimal;
  days: number;
};

/** Lo anotado desde el registro: movimientos, gastos y ventas en dólares. */
export async function trialValue(
  tx: Tx,
  tenantId: string,
  since: Date,
  now: Date,
): Promise<TrialValue> {
  const m = schema.movement;
  const [r] = rows<{ n: number | string; exp: string | null; sales: string | null }>(
    await tx.execute(sql`
      select count(*) as n,
             coalesce(sum(${m.amountUsd}) filter (where ${m.type} = 'expense'), 0)::text as exp,
             coalesce(sum(${m.amountUsd}) filter (where ${m.type} = 'income'), 0)::text as sales
      from ${m}
      where ${m.tenantId} = ${tenantId} and ${m.deletedAt} is null
        and ${m.createdAt} >= ${since.toISOString()}::timestamptz
    `),
  );
  return {
    movements: Number(r?.n ?? 0),
    expensesUsd: new Decimal(r?.exp ?? 0),
    salesUsd: new Decimal(r?.sales ?? 0),
    days: Math.max(1, Math.floor((now.getTime() - since.getTime()) / DAY_MS)),
  };
}

type Pending = {
  tenantId: string;
  phoneId: string;
  e164: string;
  kind: "survey" | "value";
  out: Outbound;
};

/** Qué le toca a un negocio en prueba hoy (si le toca algo y está en la ventana). Lo marca. */
async function takeLifecycle(tx: Tx, tenantId: string, now: Date): Promise<Pending | null> {
  const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (t?.status !== "trial" || t.deletedAt) return null;
  const age = Math.floor((now.getTime() - t.createdAt.getTime()) / DAY_MS);
  const kind =
    age >= VALUE_DAY && !t.valueSentAt
      ? "value"
      : age >= SURVEY_DAY && !t.surveySentAt
        ? "survey"
        : null;
  if (!kind) return null;
  const [owner] = await tx
    .select({ id: schema.phoneNumber.id, e164: schema.phoneNumber.e164 })
    .from(schema.phoneNumber)
    .where(
      and(
        eq(schema.phoneNumber.tenantId, tenantId),
        eq(schema.phoneNumber.role, "owner"),
        eq(schema.phoneNumber.status, "active"),
      ),
    )
    .limit(1);
  if (!owner?.e164) return null;
  // Ventana de servicio de Meta: el dueño escribió en las últimas 24 horas.
  const [recent] = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, owner.id),
        eq(schema.message.direction, "in"),
        gte(schema.message.createdAt, new Date(now.getTime() - DAY_MS + 30 * 60_000)),
      ),
    )
    .limit(1);
  if (!recent) return null;
  let out: Outbound;
  if (kind === "survey") {
    out = es.surveyFair();
    await tx.update(schema.tenant).set({ surveySentAt: now }).where(eq(schema.tenant.id, tenantId));
  } else {
    const v = await trialValue(tx, tenantId, t.createdAt, now);
    out = es.valueSummary({
      ...v,
      business: t.businessType !== "personal",
      trialEndsOn: t.trialEndsAt ? businessDateOf(t.trialEndsAt) : null,
      founder: Boolean(t.founderUntil),
    });
    // La encuesta ya no hace falta si se llega al día 12 sin haberla mandado.
    await tx
      .update(schema.tenant)
      .set({ valueSentAt: now, surveySentAt: t.surveySentAt ?? now })
      .where(eq(schema.tenant.id, tenantId));
  }
  return { tenantId, phoneId: owner.id, e164: owner.e164, kind, out };
}

export async function sendLifecycleNotices(
  db: Db,
  meta: MetaClient | null,
  opts: { now: Date; log?: Logger },
): Promise<{ survey: number; value: number; failed: number }> {
  const log = opts.log ?? silentLogger;
  const result = { survey: 0, value: 0, failed: 0 };
  if (!meta) return result;
  for (const tenantId of await everyTenantId(db)) {
    try {
      // Se marca y se confirma primero; se envía después. Un fallo no repite el aviso.
      const p = await withTenant(db, tenantId, (tx) => takeLifecycle(tx, tenantId, opts.now));
      if (!p) continue;
      try {
        const r = await sendOutbound(meta, p.e164, p.out);
        await withTenant(db, tenantId, (tx) =>
          tx.insert(schema.message).values({
            tenantId,
            phoneId: p.phoneId,
            direction: "out",
            kind: p.out.type,
            body: p.out.body,
            status: "ok",
            waMessageId: r.waMessageId,
            toolCalls: [{ name: `lifecycle_${p.kind}`, args: {} }],
          }),
        );
        result[p.kind] += 1;
      } catch (err) {
        result.failed += 1;
        log.warn(
          { err: err instanceof Error ? err.message : String(err), to: maskPhone(p.e164) },
          "aviso de la prueba no enviado",
        );
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "ciclo de la prueba");
    }
  }
  return result;
}

export const SURVEY_QUESTIONS = ["fair", "expensive", "continue"] as const;
export type SurveyQuestion = (typeof SURVEY_QUESTIONS)[number];

/** Guarda una respuesta de la encuesta o del resumen en `tenant.survey`. */
export async function saveSurveyAnswer(
  tx: Tx,
  tenantId: string,
  question: SurveyQuestion,
  answer: string,
  now: Date,
): Promise<void> {
  const [t] = await tx
    .select({ survey: schema.tenant.survey })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const prev = (t?.survey ?? {}) as Record<string, unknown>;
  await tx
    .update(schema.tenant)
    .set({ survey: { ...prev, [question]: answer, [`${question}At`]: now.toISOString() } })
    .where(and(eq(schema.tenant.id, tenantId), isNull(schema.tenant.deletedAt)));
}
