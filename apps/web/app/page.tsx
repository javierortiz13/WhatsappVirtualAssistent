import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { Landing } from "./(marketing)/landing";
import "./landing.css";

export const metadata: Metadata = {
  title: "Asistente de Caja · Tu caja, por WhatsApp",
  description:
    "Registra gastos y ventas por WhatsApp con texto, voz o foto. Tasa BCV del día, cierre de caja y dashboard. Hecho para negocios pequeños en Venezuela.",
  openGraph: {
    title: "Asistente de Caja · Tu caja, por WhatsApp",
    description:
      "Escribe, dicta o manda la foto de la factura. El asistente la registra con la tasa BCV del día y te da el cierre cuando lo pidas.",
    locale: "es_VE",
    type: "website",
  },
};

/** Portada pública. Quien ya tiene sesión entra por "Entrar": /login lo manda a /inicio. */
export default function Home() {
  const wa = process.env.PLATFORM_WA_NUMBER;
  const waUrl = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent("hola")}&utm_source=landing&utm_medium=cta`
    : null;
  // Foto del hero: se activa sola al dejar `public/hero.jpg` (runbook de marketing, §5).
  const heroPhoto = existsSync(join(process.cwd(), "public", "hero.jpg")) ? "/hero.jpg" : null;
  return <Landing waUrl={waUrl} heroPhoto={heroPhoto} />;
}
