import { and, eq, isNull, lt, schema, sql, type Tx } from "@caja/db";
import type { Logger } from "../log";
import type { ObjectStore } from "../storage/store";

/** Foto de factura guardada antes de que el gasto exista (provisional) o ya vinculada a un movimiento. */
export async function createAttachment(
  tx: Tx,
  input: {
    tenantId: string;
    kind: "receipt";
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(schema.attachment)
    .values(input)
    .returning({ id: schema.attachment.id });
  if (!row) throw new Error("no se pudo registrar el adjunto");
  return row.id;
}

/** Baja lógica y borrado en el bucket (best-effort: si el bucket falla, el barrido lo reintenta). */
export async function discardAttachment(
  tx: Tx,
  store: ObjectStore | null,
  tenantId: string,
  attachmentId: string,
  now: Date,
  log?: Logger,
): Promise<boolean> {
  const [row] = await tx
    .select({ key: schema.attachment.storageKey, deletedAt: schema.attachment.deletedAt })
    .from(schema.attachment)
    .where(and(eq(schema.attachment.tenantId, tenantId), eq(schema.attachment.id, attachmentId)));
  if (!row) return false;
  if (!row.deletedAt)
    await tx
      .update(schema.attachment)
      .set({ deletedAt: now })
      .where(eq(schema.attachment.id, attachmentId));
  if (store) {
    try {
      await store.delete(row.key);
    } catch (err) {
      log?.warn(
        { attachmentId, err: err instanceof Error ? err.message : String(err) },
        "no se pudo borrar del bucket",
      );
      return false;
    }
  }
  return true;
}

/**
 * Fotos provisionales que nunca se vincularon a un movimiento (borrador cancelado, vencido o que
 * falló) con más de `olderThanMs`: se dan de baja y se borran del bucket. Corre por tenant.
 */
export async function sweepOrphanAttachments(
  tx: Tx,
  store: ObjectStore | null,
  tenantId: string,
  now: Date,
  olderThanMs = 60 * 60_000,
  log?: Logger,
): Promise<number> {
  const before = new Date(now.getTime() - olderThanMs);
  const orphans = await tx
    .select({ id: schema.attachment.id })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.tenantId, tenantId),
        isNull(schema.attachment.deletedAt),
        lt(schema.attachment.createdAt, before),
        sql`not exists (select 1 from ${schema.movement} m where m.attachment_id = ${schema.attachment.id})`,
      ),
    );
  let n = 0;
  for (const o of orphans) if (await discardAttachment(tx, store, tenantId, o.id, now, log)) n++;
  return n;
}
