import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo se importan como fuente TypeScript.
  transpilePackages: ["@caja/core", "@caja/db"],
  serverExternalPackages: ["postgres", "pino"],
};

/**
 * Sentry en el build (runbook s2-monitoreo, §3): el túnel `/monitoring` evita que los bloqueadores
 * del teléfono descarten los eventos del navegador; los source maps suben solo cuando hay
 * `SENTRY_AUTH_TOKEN` (en Vercel), así el build local no avisa ni sube nada. Sin DSN el SDK no
 * envía nada, igual que antes.
 */
const token = process.env.SENTRY_AUTH_TOKEN;
export default withSentryConfig(config, {
  ...(process.env.SENTRY_ORG ? { org: process.env.SENTRY_ORG } : {}),
  ...(process.env.SENTRY_PROJECT ? { project: process.env.SENTRY_PROJECT } : {}),
  ...(token ? { authToken: token } : {}),
  silent: !process.env.CI,
  tunnelRoute: "/monitoring",
  widenClientFileUpload: true,
  sourcemaps: { disable: !token },
  telemetry: false,
});
