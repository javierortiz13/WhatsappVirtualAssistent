import { scrubSentryEvent } from "@caja/core/log";
import * as Sentry from "@sentry/nextjs";

/**
 * Sentry en el servidor de Next (Node y, si algún día hay rutas edge, también ahí). Sin DSN no
 * hace nada. Nunca envía cuerpos de mensajes: solo la excepción y sus etiquetas.
 */
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  if (process.env.NEXT_RUNTIME !== "nodejs" && process.env.NEXT_RUNTIME !== "edge") return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // Los errores de la base traen los parámetros de la consulta: se recortan antes de salir (ER-3).
    beforeSend: (event) => scrubSentryEvent(event),
  });
}

export const onRequestError = Sentry.captureRequestError;
