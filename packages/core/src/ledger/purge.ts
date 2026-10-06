import { and, type Db, inArray, isNull, lt, ne, schema, sql, type Tx } from "@caja/db";
import type { Logger } from "../log";
import type { ObjectStore } from "../storage/store";
import { discardAttachment } from "./attachments";

/**
 * Conservación prometida en /privacidad (06/10/2026):
 * - El texto de los mensajes se borra a los 90 días: el cuerpo (texto o transcripción), los
 *   argumentos de `tool_calls` (quedan solo los nombres, para las métricas), el contenido de los
 *   borradores ya resueltos y el mensaje crudo del webhook.
 * - Las fotos de facturas se borran a los 12 meses (del bucket y baja lógica del adjunto).
 * Los movimientos no se tocan: se conservan mientras la cuenta esté activa. Corre en el
 * housekeeping; las fotos van por tandas para no alargar la transacción.
 */
export const MESSAGE_TEXT_DAYS = 90;
export const PHOTO_DAYS = 365;
const PHOTO_BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Por negocio, dentro de `withTenant` (las tablas tienen RLS). */
export async function purgeOldTenantData(
  tx: Tx,
  store: ObjectStore | null,
  tenantId: string,
  now: Date,
  log?: Logger,
): Promise<{ texts: number; drafts: number; photos: number }> {
  const textCutoff = new Date(now.getTime() - MESSAGE_TEXT_DAYS * DAY_MS);
  const m = schema.message;
  const texts = await tx
    .update(m)
    .set({
      body: null,
      toolCalls: sql`(select jsonb_agg(jsonb_build_object('name', e->'name'))
                      from jsonb_array_elements(case when jsonb_typeof(${m.toolCalls}) = 'array'
                                                     then ${m.toolCalls} else '[]'::jsonb end) e)`,
    })
    .where(
      and(
        sql`${m.tenantId} = ${tenantId}`,
        lt(m.createdAt, textCutoff),
        sql`(${m.body} is not null or ${m.toolCalls} @? '$[*].args')`,
      ),
    )
    .returning({ id: m.id });

  const p = schema.pendingAction;
  const drafts = await tx
    .update(p)
    .set({ payload: sql`'{}'::jsonb` })
    .where(
      and(
        sql`${p.tenantId} = ${tenantId}`,
        ne(p.status, "pending"),
        lt(p.createdAt, textCutoff),
        sql`${p.payload} <> '{}'::jsonb`,
      ),
    )
    .returning({ id: p.id });

  const photoCutoff = new Date(now.getTime() - PHOTO_DAYS * DAY_MS);
  const a = schema.attachment;
  const old = await tx
    .select({ id: a.id })
    .from(a)
    .where(and(sql`${a.tenantId} = ${tenantId}`, isNull(a.deletedAt), lt(a.createdAt, photoCutoff)))
    .limit(PHOTO_BATCH);
  let photos = 0;
  for (const o of old) if (await discardAttachment(tx, store, tenantId, o.id, now, log)) photos++;
  return { texts: texts.length, drafts: drafts.length, photos };
}

/** El mensaje crudo de Meta (webhook_event, sin RLS) de eventos ya cerrados con más de 90 días. */
export async function purgeOldWebhookPayloads(db: Db, now: Date): Promise<number> {
  const w = schema.webhookEvent;
  const cutoff = new Date(now.getTime() - MESSAGE_TEXT_DAYS * DAY_MS);
  const rows = await db
    .update(w)
    .set({ payload: sql`'{"purged": true}'::jsonb` })
    .where(
      and(
        lt(w.receivedAt, cutoff),
        inArray(w.status, ["done", "ignored", "expired", "failed"]),
        sql`not (${w.payload} ? 'purged')`,
      ),
    )
    .returning({ id: w.id });
  return rows.length;
}
