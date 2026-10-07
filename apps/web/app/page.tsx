import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { Landing } from "./(marketing)/landing";
import "./landing.css";

export const metadata: Metadata = {
  title: "Rocco · Tu amigo fiel con tus finanzas",
  description:
    "Rocco lleva tus gastos, ventas y cuentas por WhatsApp: texto, voz o foto, en bolívares y dólares con la tasa BCV del día. Para tus finanzas personales y tu negocio, en Venezuela.",
  openGraph: {
    title: "Rocco · Tu amigo fiel con tus finanzas",
    description:
      "Escríbele, díctale o mándale la foto de la factura. Rocco la anota con la tasa BCV del día y te dice cómo vas.",
    locale: "es_VE",
    type: "website",
  },
};

/** Portada pública. Quien ya tiene sesión entra por "Entrar": /login lo manda a /inicio. */
export default function Home() {
  const wa = process.env.PLATFORM_WA_NUMBER;
  const waUrl = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent("Hola Rocco")}&utm_source=landing&utm_medium=cta`
    : null;
  // Foto del hero: se activa sola al dejar `public/hero.jpg` (runbook de marketing, §5).
  const heroPhoto = existsSync(join(process.cwd(), "public", "hero.jpg")) ? "/hero.jpg" : null;
  return <Landing waUrl={waUrl} heroPhoto={heroPhoto} />;
}
