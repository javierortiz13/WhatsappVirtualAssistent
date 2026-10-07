import { and, eq, gte, rows, schema, sql, type Tx } from "@caja/db";
import { Decimal } from "../domain/money";
import { TRIAL_BUDGET_USD, TRIAL_MESSAGES } from "./plans";

/**
 * Límites de la prueba gratis. Desde el 07/10/2026 la prueba se mide en MENSAJES del usuario (100
 * para todos, `TRIAL_MESSAGES`). El tope de gasto (0016) queda
 * como red de seguridad. Mientras el negocio está en prueba se suma lo que costó desde que se
 * registró:
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
  /** Mensajes regalados desde /admin: en la prueba suben su tope (07/10). */
  extraMessages?: number;
};

export type TrialSpend = {
  budgetUsd: Decimal;
  spentUsd: Decimal;
  aiUsd: Decimal;
  metaUsd: Decimal;
  voiceUsd: Decimal;
  replies: number;
  /** Mensajes del usuario desde el registro y los que incluye la prueba. */
  messages: number;
  messageCap: number;
  /** Ya llegó al tope: el bot no registra más hasta activar el plan. */
  reached: boolean;
  /** Pasó los mensajes (no la red de seguridad en dólares). */
  byMessages: boolean;
};

/** Mensajes de la prueba: los 100 de todos más los que regaló el administrador. */
export function trialMessageCap(t: Pick<TrialTenant, "extraMessages">): number {
  return TRIAL_MESSAGES + Math.max(0, t.extraMessages ?? 0);
}

/** Red de seguridad en USD: la propia del negocio o $4 por cada 100 mensajes de su prueba. */
export function trialBudget(
  t: Pick<TrialTenant, "plan" | "trialBudgetUsd" | "extraMessages">,
): Decimal {
  return t.trialBudgetUsd !== null
    ? new Decimal(t.trialBudgetUsd)
    : new Decimal(TRIAL_BUDGET_USD).mul(trialMessageCap(t)).div(TRIAL_MESSAGES);
}

export async function trialSpend(
  tx: Tx,
  t: TrialTenant,
  opts: { metaRateUsd?: number } = {},
): Promise<TrialSpend> {
  const m = schema.message;
  const [r] = rows<{
    ai: string | null;
    replies: number | string;
    voice: number | string;
    inbound: number | string;
  }>(
    await tx.execute(sql`
      select coalesce(sum(${m.costUsd}), 0)::text as ai,
             count(*) filter (where ${m.direction} = 'out' and ${m.kind} <> 'reaction'
                              and ${m.status} <> 'failed') as replies,
             count(*) filter (where ${m.direction} = 'in' and ${m.kind} = 'audio') as voice,
             count(*) filter (where ${m.direction} = 'in') as inbound
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
  const messages = Number(r?.inbound ?? 0);
  const messageCap = trialMessageCap(t);
  // El mensaje que llega ya está guardado: con 100 incluidos, el 101 es el que para.
  const byMessages = messages > messageCap;
  return {
    budgetUsd,
    spentUsd,
    aiUsd,
    metaUsd,
    voiceUsd,
    replies,
    messages,
    messageCap,
    byMessages: t.status === "trial" && byMessages,
    reached: t.status === "trial" && (byMessages || spentUsd.gte(budgetUsd)),
  };
}
