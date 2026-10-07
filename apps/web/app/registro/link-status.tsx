"use client";

import { useEffect, useState } from "react";

/** Espera el mensaje del dueño: consulta el estado cada 3 s y muestra cuánto le queda al código. */
export function LinkStatus({ expiresAt }: { expiresAt: number }) {
  const [status, setStatus] = useState<"waiting" | "active">("waiting");
  // null hasta montar: el servidor y el navegador no comparten reloj (evita el desajuste al hidratar).
  const [left, setLeft] = useState<number | null>(null);
  const expired = left === 0;

  useEffect(() => {
    const update = () => setLeft(Math.max(0, expiresAt - Date.now()));
    update();
    const tick = setInterval(update, 1000);
    return () => clearInterval(tick);
  }, [expiresAt]);

  useEffect(() => {
    // Con el código vencido no tiene sentido seguir consultando.
    if (status === "active" || expired) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/registro/estado", { cache: "no-store" });
        const j = (await r.json()) as { status?: string };
        if (!stop && j.status === "active") setStatus("active");
      } catch {
        // Sin red: se reintenta en el próximo ciclo.
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [status, expired]);

  if (status === "active") {
    return (
      <div className="notice ok stack">
        <p style={{ margin: 0 }}>
          <strong>✅ ¡Listo! Tu número quedó vinculado.</strong> Ya puedes escribirle a Rocco.
        </p>
        <a className="btn" href="/inicio?bienvenida=1">
          Ver qué puedo hacer ›
        </a>
      </div>
    );
  }
  if (left === null)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 14 }} aria-live="polite">
        ◌ Esperando tu mensaje…
      </p>
    );
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <p className="muted" style={{ margin: 0, fontSize: 14 }} aria-live="polite">
      {left > 0 ? `◌ Esperando tu mensaje… Vence en ${mm}:${ss}` : "El código venció. Genera otro."}
    </p>
  );
}
