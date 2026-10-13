import { and, type Db, dueDraftTenantIds, eq, lte, schema, withTenant } from "@caja/db";
import { type Logger, maskPhone, silentLogger } from "../log";
import type { Outbound } from "../render/index";
import type { MetaClient } from "../whatsapp/client";
import { sendOutbound, settleDueDraft } from "./process";

export type AutoSaveResult = { saved: number; expired: number; sent: number; failed: number };

/**
 * Barrido del autoguardado (0022), cada minuto: los borradores vencidos se guardan (o vencen si
 * esperaban una decisión) y se reacciona ✅ sobre el mensaje del usuario. Se guarda y se confirma
 * primero; se envía después: un fallo de Meta no deshace lo guardado ni lo guarda dos veces.
 * `SKIP LOCKED`: un borrador que el usuario está tocando o corrigiendo se toma en la vuelta siguiente.
 */
export async function autoSaveDueDrafts(
  db: Db,
  metaFor: (phoneNumberId: string) => MetaClient | null,
  opts: { now: Date; fallbackNumberId?: string | null; log?: Logger },
): Promise<AutoSaveResult> {
  const log = opts.log ?? silentLogger;
  const { now } = opts;
  const result: AutoSaveResult = { saved: 0, expired: 0, sent: 0, failed: 0 };
  for (const tenantId of await dueDraftTenantIds(db, now)) {
    try {
      const deliveries = await withTenant(db, tenantId, async (tx) => {
        const due = await tx
          .select()
          .from(schema.pendingAction)
          .where(
            and(
              eq(schema.pendingAction.tenantId, tenantId),
              eq(schema.pendingAction.status, "pending"),
              lte(schema.pendingAction.expiresAt, now),
            ),
          )
          .orderBy(schema.pendingAction.createdAt)
          .for("update", { skipLocked: true });
        const out: { phoneId: string; numberId: string | null; outbound: Outbound[] }[] = [];
        for (const p of due) {
          let outbound: Outbound[];
          try {
            // Punto de guardado por borrador: uno que falla vence sin arrastrar a los demás.
            outbound = await tx.transaction((sp) => settleDueDraft(sp, p, now));
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err.message : String(err), pendingId: p.id },
              "autoguardado falló; el borrador vence",
            );
            await tx
              .update(schema.pendingAction)
              .set({ status: "expired", resolvedAt: now })
              .where(eq(schema.pendingAction.id, p.id));
            result.expired += 1;
            continue;
          }
          const [after] = await tx
            .select({ status: schema.pendingAction.status })
            .from(schema.pendingAction)
            .where(eq(schema.pendingAction.id, p.id));
          if (after?.status === "confirmed") result.saved += 1;
          else if (after?.status === "expired") result.expired += 1;
          if (outbound.length) out.push({ phoneId: p.phoneId, numberId: p.waNumberId, outbound });
        }
        return out;
      });
      for (const d of deliveries) {
        const meta = metaFor(d.numberId ?? opts.fallbackNumberId ?? "");
        if (!meta) continue;
        const [phone] = await withTenant(db, tenantId, (tx) =>
          tx
            .select({ e164: schema.phoneNumber.e164 })
            .from(schema.phoneNumber)
            .where(eq(schema.phoneNumber.id, d.phoneId)),
        );
        if (!phone) continue;
        for (const out of d.outbound) {
          try {
            const sent = await sendOutbound(meta, phone.e164, out);
            await withTenant(db, tenantId, (tx) =>
              tx.insert(schema.message).values({
                tenantId,
                phoneId: d.phoneId,
                direction: "out",
                kind: out.type,
                body: out.body,
                status: "ok",
                waMessageId: sent.waMessageId,
                toolCalls: [{ name: "auto_save", args: {} }],
              }),
            );
            result.sent += 1;
          } catch (err) {
            result.failed += 1;
            log.warn(
              { err: err instanceof Error ? err.message : String(err), to: maskPhone(phone.e164) },
              "acuse del autoguardado no enviado",
            );
          }
        }
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), tenantId },
        "barrido del autoguardado",
      );
    }
  }
  return result;
}
