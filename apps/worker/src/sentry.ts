import { scrubSentryEvent } from "@caja/core";
import { QUEUES } from "@caja/db/queue";
import * as Sentry from "@sentry/node";

/** Sentry del worker. Sin DSN no hace nada. Nunca recibe cuerpos de mensajes ni números. */
export function initSentry(dsn: string | undefined, environment: string): boolean {
  if (!dsn) return false;
  // Los errores de la base traen los parámetros de la consulta: se recortan antes de salir (ER-3).
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event),
    // SDK 11: sin cuerpos, IP, cookies ni query string (SEC-1, S-1a).
    dataCollection: { userInfo: false, httpBodies: [], cookies: false, urlQueryParams: false },
  });
  return true;
}

export function captureError(
  err: unknown,
  tags: Record<string, string> = {},
  level: "error" | "fatal" = "error",
): void {
  Sentry.captureException(err, { tags, level });
}

/**
 * Etiquetas y nivel de un error de job (10/11). Un mensaje entrante que falla al procesarse lleva
 * `alert: inbound_failed`: la regla de alerta de Sentry avisa con esa etiqueta en minutos. El
 * último intento (el mensaje se queda sin respuesta) sale como `fatal`. Sin números ni textos.
 */
export function jobErrorContext(
  queue: string,
  final = false,
): { tags: Record<string, string>; level: "error" | "fatal" } {
  if (queue !== QUEUES.processMessage) return { tags: { queue }, level: "error" };
  return {
    tags: { queue, alert: "inbound_failed", final: final ? "yes" : "no" },
    level: final ? "fatal" : "error",
  };
}

export { Sentry };
