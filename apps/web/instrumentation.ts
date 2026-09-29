import * as Sentry from "@sentry/nextjs";

/** Sentry en el servidor de Next. Sin DSN no hace nada. Nunca envía cuerpos de mensajes. */
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
  });
}

export const onRequestError = Sentry.captureRequestError;
