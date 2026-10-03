import { type Db, everyTenantId, schema, withTenant } from "@caja/db";
import { takePaymentNotices } from "../billing/renew";
import { businessDateOf } from "../domain/dates";
import { type Logger, maskPhone, silentLogger } from "../log";
import { es } from "../render/index";
import type { MetaClient } from "../whatsapp/client";
import { sendOutbound } from "./process";

/**
 * Avisos de "pago verificado" o "no verificado" por WhatsApp (03/10). Corre en el housekeeping:
 * toma los pagos revisados sin aviso, los marca y escribe al dueño si le habló al bot en las
 * últimas 24 horas (fuera de esa ventana Meta exige plantilla; el estado se ve en "Mi plan").
 */
export async function sendPaymentNotices(
  db: Db,
  meta: MetaClient | null,
  opts: { now: Date; supportHint: string | null; log?: Logger },
): Promise<{ sent: number; skipped: number }> {
  const log = opts.log ?? silentLogger;
  let sent = 0;
  let skipped = 0;
  for (const tenantId of await everyTenantId(db)) {
    try {
      // 1) Se marcan y se confirma en la base; 2) se envía fuera de la transacción. Así un fallo
      // al confirmar no repite el aviso cada 5 minutos (antes se enviaba dentro de la transacción).
      const notices = await withTenant(db, tenantId, (tx) =>
        takePaymentNotices(tx, tenantId, opts.now),
      );
      for (const n of notices) {
        if (!n.to || !meta) {
          skipped += 1;
          continue;
        }
        const out =
          n.status === "approved"
            ? es.paymentVerified(n.plan.name, n.paidUntil ? businessDateOf(n.paidUntil) : null)
            : es.paymentRejected({
                reference: n.reference,
                reason: n.reason,
                supportHint: opts.supportHint,
              });
        try {
          const r = await sendOutbound(meta, n.to.e164, out);
          const to = n.to;
          await withTenant(db, tenantId, (tx) =>
            tx.insert(schema.message).values({
              tenantId,
              phoneId: to.phoneId,
              direction: "out",
              kind: out.type,
              body: out.body,
              status: "ok",
              waMessageId: r.waMessageId,
            }),
          );
          sent += 1;
        } catch (err) {
          // Ya quedó marcado: no se reintenta en bucle; el dueño lo ve en "Mi plan".
          skipped += 1;
          log.warn(
            { err: err instanceof Error ? err.message : String(err), to: maskPhone(n.to.e164) },
            "aviso de pago no enviado",
          );
        }
      }
    } catch (err) {
      // Un negocio con error no frena los avisos de los demás.
      log.error({ err: err instanceof Error ? err.message : String(err) }, "avisos de pago");
    }
  }
  return { sent, skipped };
}
