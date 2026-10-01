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
  });
}

export const onRequestError = Sentry.captureRequestError;
