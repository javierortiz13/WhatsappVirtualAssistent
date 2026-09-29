import type { ReactNode } from "react";

export const metadata = {
  title: "Asistente de Caja",
  description: "Tu caja, por WhatsApp.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-VE">
      <body>{children}</body>
    </html>
  );
}
