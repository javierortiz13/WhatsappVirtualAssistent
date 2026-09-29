import type { Metadata } from "next";

export const metadata: Metadata = { title: "Cierres" };

export default function Cierres() {
  return (
    <div className="card">
      <p className="kpi-label">Cierres</p>
      <p style={{ margin: 0 }}>
        El cierre diario y los resúmenes por período llegan en el siguiente sprint. Por ahora
        pídelos por WhatsApp con <strong>Ver cierre</strong>.
      </p>
    </div>
  );
}
