import {
  and,
  type Db,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  schema,
  sql,
  type Tx,
} from "@caja/db";
import type { Logger } from "../log";
import type { ObjectStore } from "../storage/store";
import { discardAttachment } from "./attachments";

/**
 * Conservación prometida en /privacidad (06/10/2026):
 * - El texto de los mensajes se borra a los 90 días: el cuerpo (texto o transcripción), los
 *   argumentos de `tool_calls` (quedan solo los nombres, para las métricas), el contenido de los
 *   borradores ya resueltos y el mensaje crudo del webhook.
 * - Las fotos de facturas se borran a los 12 meses (del bucket y baja lógica del adjunto).
 * - Los recordatorios se borran 90 días después de cumplidos, vencidos o borrados (hábitos P-4).
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
): Promise<{ texts: number; drafts: number; photos: number; reminders: number }> {
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
  // `updated_at` es cuándo se cumplió, venció o se borró: después no cambia.
  const r = schema.reminder;
  const reminders = await tx
    .delete(r)
    .where(
      and(
        sql`${r.tenantId} = ${tenantId}`,
        inArray(r.status, ["done", "expired", "cancelled"]),
        lt(r.updatedAt, textCutoff),
      ),
    )
    .returning({ id: r.id });
  return { texts: texts.length, drafts: drafts.length, photos, reminders: reminders.length };
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

/**
 * Registros por WhatsApp sin terminar (US-AD-05, decisión 3A del 29/10/2026; /privacidad PV-3r):
 * 90 días después del último mensaje de la persona se borran. Si dijo «no me escribas» o Rocco ya
 * le escribió (`rescue_via` window o template), la fila no se borra: queda solo el número y esa
 * marca, para que «no te vuelve a escribir por su cuenta» (PR-1) se cumpla si vuelve.
 */
export const SIGNUP_ABANDONED_DAYS = 90;

export async function purgeAbandonedSignups(
  db: Db,
  now: Date,
): Promise<{ deleted: number; kept: number }> {
  const s = schema.signup;
  const cutoff = new Date(now.getTime() - SIGNUP_ABANDONED_DAYS * DAY_MS);
  const due = and(isNull(s.completedAt), isNull(s.purgedAt), lt(s.updatedAt, cutoff));
  const marked = or(isNotNull(s.contactOffAt), inArray(s.rescueVia, ["window", "template"]));
  return db.transaction(async (tx) => {
    // a) Con marca: se vacía todo menos el número, el «no me escribas» y el rescate.
    const kept = await tx
      .update(s)
      .set({
        waUserId: null,
        profileName: null,
        tenantId: null,
        rescueWaMessageId: null,
        founderContactedAt: null,
        step: "name",
        data: {},
        messages: 0,
        createdAt: now,
        updatedAt: now,
        purgedAt: now,
      })
      .where(and(due, marked))
      .returning({ id: s.id });
    // b) Sin marca: se borra entera. Escrito a prueba de NULL: not(or(...)) con rescue_via NULL
    // da NULL y no borraría nada.
    const deleted = await tx
      .delete(s)
      .where(
        and(
          due,
          isNull(s.contactOffAt),
          sql`${s.rescueVia} is distinct from 'window'`,
          sql`${s.rescueVia} is distinct from 'template'`,
        ),
      )
      .returning({ id: s.id });
    return { deleted: deleted.length, kept: kept.length };
  });
}

/**
 * F-8 (revisión de anuncios, 27/10): los contadores de mensajes por número (`<e164>`,
 * `k:<e164>`, `sig:invalid`) se borran al día. La ventana más larga es de 60 min, así que el
 * límite no cambia, y un número borrado por `erase_tenant` ya no sobrevive como `k:<e164>`.
 */
export async function purgeOldSenderHits(db: Db, now: Date): Promise<number> {
  const h = schema.unknownSenderHit;
  const rows = await db
    .delete(h)
    .where(lt(h.windowStart, new Date(now.getTime() - DAY_MS)))
    .returning({ key: h.e164 });
  return rows.length;
}
