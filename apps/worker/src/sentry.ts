import { scrubSentryEvent } from "@caja/core";
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
  });
  return true;
}

export function captureError(err: unknown, tags: Record<string, string> = {}): void {
  Sentry.captureException(err, { tags });
}

export { Sentry };
