import { type Db, schema, type Tx } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { type Logger, maskPhone, silentLogger } from "../log.js";
import { parseWebhook } from "../whatsapp/parse.js";
import type { InboundMessage } from "../whatsapp/types.js";

/**
 * Ingesta de un webhook (Fase 3, ADR-004): por cada mensaje, en una transacción, se guarda el
 * evento crudo con clave única (idempotencia) y se encola el job. Un duplicado no crea job.
 * Estados (entregado, leído) no generan job; solo se guardan los fallidos, que traen el motivo.
 * Nunca llama al LLM ni a Meta: debe terminar en milisegundos.
 */
export type IngestDeps = {
  db: Db;
  enqueue: (tx: Tx, job: ProcessMessageJob, serializationKey: string) => Promise<unknown>;
  log?: Logger;
  now?: () => Date;
};

export type IngestResult = {
  accepted: number;
  duplicates: number;
  failedStatuses: number;
  ignored: number;
};

export function eventKeyFor(m: InboundMessage): string {
  return `msg:${m.waMessageId}`;
}

export function serializationKeyFor(m: InboundMessage): string {
  return m.sender.e164 ?? m.sender.waUserId ?? `unknown:${m.waMessageId}`;
}

export async function ingestWebhook(deps: IngestDeps, payload: unknown): Promise<IngestResult> {
  const log = deps.log ?? silentLogger;
  const parsed = parseWebhook(payload);
  const result: IngestResult = {
    accepted: 0,
    duplicates: 0,
    failedStatuses: 0,
    ignored: parsed.ignoredChanges,
  };

  for (const m of parsed.messages) {
    const inserted = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.webhookEvent)
        .values({ eventKey: eventKeyFor(m), payload: m, status: "received" })
        .onConflictDoNothing({ target: schema.webhookEvent.eventKey })
        .returning({ id: schema.webhookEvent.id });
      const row = rows[0];
      if (!row) return false;
      await deps.enqueue(
        tx,
        {
          webhookEventId: row.id,
          waMessageId: m.waMessageId,
          phoneNumberId: m.phoneNumberId,
          senderE164: m.sender.e164,
          senderWaUserId: m.sender.waUserId,
        },
        serializationKeyFor(m),
      );
      return true;
    });
    if (inserted) {
      result.accepted += 1;
      log.info(
        { kind: m.kind, from: maskPhone(m.sender.e164), waMessageId: m.waMessageId },
        "mensaje encolado",
      );
    } else {
      result.duplicates += 1;
      log.debug({ waMessageId: m.waMessageId }, "webhook duplicado ignorado");
    }
  }

  for (const s of parsed.statuses) {
    if (s.status !== "failed" && s.errors.length === 0) continue;
    await deps.db
      .insert(schema.webhookEvent)
      .values({ eventKey: `status:${s.waMessageId}:${s.status}`, payload: s, status: "ignored" })
      .onConflictDoNothing({ target: schema.webhookEvent.eventKey });
    result.failedStatuses += 1;
    log.warn({ waMessageId: s.waMessageId, errors: s.errors }, "estado de entrega fallido");
  }

  return result;
}
