import { and, eq, gte, rows, schema, sql, type Tx } from "@caja/db";
import { Decimal } from "../domain/money";
import { planById } from "./plans";

/**
 * Tope de gasto de la prueba gratis (0016, 06/10/2026). Mientras el negocio está en prueba se suma
 * lo que costó desde que se registró:
 * - IA: `message.cost_usd` de cada turno (agente y lectura de fotos), exacto;
 * - Meta: cada respuesta entregada (sin reacciones) a la tarifa de servicio (ADR-014). Se cuenta
 *   aunque caiga en las 1.000 gratis del mes: el tope es el peor caso;
 * - voz: cada nota de voz a un precio fijo de Deepgram (una nota típica de 20 a 25 s).
 * Al llegar al tope el bot deja de registrar (sin LLM ni transcripción) y ofrece activar el plan.
 */
export const META_MSG_RATE_USD = 0.0113;
export const VOICE_NOTE_USD = 0.003;

export type TrialTenant = {
  id: string;
  plan: string;
  status: string;
  createdAt: Date;
  trialBudgetUsd: string | null;
};

export type TrialSpend = {
  budgetUsd: Decimal;
  spentUsd: Decimal;
  aiUsd: Decimal;
  metaUsd: Decimal;
  voiceUsd: Decimal;
  replies: number;
  /** Ya llegó al tope: el bot no registra más hasta activar el plan. */
  reached: boolean;
};

export function trialBudget(t: Pick<TrialTenant, "plan" | "trialBudgetUsd">): Decimal {
  return t.trialBudgetUsd !== null
    ? new Decimal(t.trialBudgetUsd)
    : new Decimal(planById(t.plan).trialBudgetUsd);
}

export async function trialSpend(
  tx: Tx,
  t: TrialTenant,
  opts: { metaRateUsd?: number } = {},
): Promise<TrialSpend> {
  const m = schema.message;
  const [r] = rows<{ ai: string | null; replies: number | string; voice: number | string }>(
    await tx.execute(sql`
      select coalesce(sum(${m.costUsd}), 0)::text as ai,
             count(*) filter (where ${m.direction} = 'out' and ${m.kind} <> 'reaction'
                              and ${m.status} <> 'failed') as replies,
             count(*) filter (where ${m.direction} = 'in' and ${m.kind} = 'audio') as voice
      from ${m}
      where ${and(eq(m.tenantId, t.id), gte(m.createdAt, t.createdAt))}
    `),
  );
  const replies = Number(r?.replies ?? 0);
  const aiUsd = new Decimal(r?.ai ?? 0);
  const metaUsd = new Decimal(opts.metaRateUsd ?? META_MSG_RATE_USD).mul(replies);
  const voiceUsd = new Decimal(VOICE_NOTE_USD).mul(Number(r?.voice ?? 0));
  const spentUsd = aiUsd.plus(metaUsd).plus(voiceUsd);
  const budgetUsd = trialBudget(t);
  return {
    budgetUsd,
    spentUsd,
    aiUsd,
    metaUsd,
    voiceUsd,
    replies,
    reached: t.status === "trial" && spentUsd.gte(budgetUsd),
  };
}
