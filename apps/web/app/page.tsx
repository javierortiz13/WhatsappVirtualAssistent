import { existsSync } from "node:fs";
import { join } from "node:path";
import { LAUNCH_DEFAULTS, launchSettings } from "@caja/core";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { Landing } from "./(marketing)/landing";
import "./landing.css";

export const metadata: Metadata = {
  title: "Rocco · Tu amigo fiel con tus finanzas",
  description:
    "Rocco es tu pana en WhatsApp para las finanzas: anota tus gastos, ventas y cuentas en bolívares y dólares, y está pendiente de la tasa BCV por ti. Para lo personal y para tu negocio, en Venezuela.",
  openGraph: {
    title: "Rocco · Tu amigo fiel con tus finanzas",
    description:
      "Escríbele, díctale o mándale la foto de la factura. Rocco la anota con la tasa BCV del día y te dice cómo vas.",
    locale: "es_VE",
    type: "website",
  },
};

/** El modo beta/live se cambia en /admin; la portada lo relee cada 5 minutos (y al guardarlo). */
export const revalidate = 300;

/** Sin base (por ejemplo, durante el build) queda el valor por defecto: beta. */
async function isBeta(): Promise<boolean> {
  try {
    return (await launchSettings(db())).beta;
  } catch {
    return LAUNCH_DEFAULTS.beta;
  }
}

/** Portada pública. Quien ya tiene sesión entra por "Entrar": /login lo manda a /inicio. */
export default async function Home() {
  const wa = process.env.PLATFORM_WA_NUMBER;
  const waUrl = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent("Hola Rocco")}&utm_source=landing&utm_medium=cta`
    : null;
  // Foto del hero: se activa sola al dejar `public/hero.jpg` (runbook de marketing, §5).
  const heroPhoto = existsSync(join(process.cwd(), "public", "hero.jpg")) ? "/hero.jpg" : null;
  return <Landing waUrl={waUrl} heroPhoto={heroPhoto} beta={await isBeta()} />;
}
