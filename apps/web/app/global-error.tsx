"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="es-VE">
      <body style={{ fontFamily: "system-ui", padding: 24 }}>
        <h1>Algo salió mal</h1>
        <p>Ya quedó registrado. Recarga la página o vuelve en unos minutos.</p>
      </body>
    </html>
  );
}
