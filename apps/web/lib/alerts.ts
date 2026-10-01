import "server-only";
import { countHit } from "@caja/core";
import * as Sentry from "@sentry/nextjs";
import { db } from "./db";

/** Checklist de seguridad S2: más de 10 firmas inválidas por minuto → una alerta por ventana. */
export const INVALID_SIGNATURE_MAX_PER_MIN = 10;

/**
 * Cuenta la firma inválida en la base (compartida entre instancias) y avisa a Sentry justo al
 * cruzar el umbral, una sola vez por ventana. Un ataque de firmas no infla Sentry: a partir de
 * la 12.ª solo suma. La fila es una sola (`sig:invalid`), así el costo por intento es un upsert.
 */
export async function noteInvalidSignature(now = new Date()): Promise<void> {
  const hits = await countHit(db(), "sig:invalid", { windowMs: 60_000, now });
  if (hits === INVALID_SIGNATURE_MAX_PER_MIN + 1) {
    Sentry.captureMessage("webhook: más de 10 firmas inválidas en un minuto", {
      level: "warning",
      tags: { source: "webhook", kind: "invalid_signature_burst" },
    });
  }
}
