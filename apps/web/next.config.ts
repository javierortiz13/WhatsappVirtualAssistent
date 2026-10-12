import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * Política de contenido: todo sale de nuestro dominio (Supabase y Sentry van por el servidor o el
 * túnel `/monitoring`), salvo la fuente Geist de Google Fonts. `'unsafe-inline'` en scripts hace
 * falta porque Next mete el payload de RSC en scripts en línea y no usamos nonces; lo que sí cierra
 * es cargar código o enmarcar la página desde otro sitio. En desarrollo Next necesita eval y el
 * websocket de recarga.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const config: NextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo se importan como fuente TypeScript.
  transpilePackages: ["@caja/core", "@caja/db"],
  serverExternalPackages: ["postgres", "pino"],
  poweredByHeader: false,
  // Security headers en todas las respuestas (auditoría de seguridad del 12/10/2026).
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
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
