import { scrubSentryEvent } from "@caja/core/log";
import * as Sentry from "@sentry/nextjs";

/** Sentry en el navegador. Sin DSN público no hace nada. Los eventos salen por el túnel `/monitoring`. */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // El mismo recorte que en el servidor (SEC-1).
    beforeSend: (event) => scrubSentryEvent(event),
    // SDK 11: sin cuerpos, IP, cookies ni query string (SEC-1, S-1a).
    dataCollection: { userInfo: false, httpBodies: [], cookies: false, urlQueryParams: false },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
