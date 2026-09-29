import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Asistente de Caja", template: "%s · Asistente de Caja" },
  description: "Tu caja, por WhatsApp.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Caja", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-VE">
      <body>{children}</body>
    </html>
  );
}
