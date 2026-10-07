"use client";

import { useEffect, useState } from "react";

/** Espera el código por WhatsApp: consulta cada 3 s y muestra cuánto le queda. */
export function ConnectStatus({ expiresAt }: { expiresAt: number }) {
  const [linked, setLinked] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const expired = left === 0;

  useEffect(() => {
    const update = () => setLeft(Math.max(0, expiresAt - Date.now()));
    update();
    const tick = setInterval(update, 1000);
    return () => clearInterval(tick);
  }, [expiresAt]);

  useEffect(() => {
    if (linked || expired) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/registro/conectar/estado", { cache: "no-store" });
        const j = (await r.json()) as { status?: string };
        if (!stop && j.status === "active") setLinked(true);
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
  }, [linked, expired]);

  if (linked)
    return (
      <div className="notice ok stack">
        <p style={{ margin: 0 }}>
          <strong>✅ ¡Listo! Tu dashboard quedó conectado.</strong>
        </p>
        <a className="btn" href="/inicio">
          Ir a mi dashboard ›
        </a>
      </div>
    );
  if (left === null)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 14 }} aria-live="polite">
        ◌ Esperando tu mensaje…
      </p>
    );
  if (expired)
    return (
      <p className="notice err" style={{ margin: 0 }}>
        El código venció. Genera otro y envíalo.
      </p>
    );
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <p className="muted" style={{ margin: 0, fontSize: 14 }} aria-live="polite">
      ◌ Esperando tu mensaje… el código sirve {mm}:{ss} más.
    </p>
  );
}
