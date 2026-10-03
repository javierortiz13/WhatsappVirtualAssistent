"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Error dentro de la app: queda el menú y se puede reintentar. Sin esto, cualquier error de una
 * página caía en global-error, que reemplaza el documento entero.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="card stack center-text">
      <h2 style={{ margin: 0 }}>Algo salió mal</h2>
      <p className="sub">Ya quedó registrado. Inténtalo de nuevo o vuelve en unos minutos.</p>
      <div className="center">
        <button className="btn" type="button" onClick={() => reset()}>
          Reintentar
        </button>
      </div>
    </div>
  );
}
