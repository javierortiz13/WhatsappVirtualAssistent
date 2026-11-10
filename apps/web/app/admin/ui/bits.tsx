import type { ReactNode } from "react";

/** Piezas de presentación de /admin (rediseño 08/11): sin datos ni efectos. */

export function Head({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: ReactNode | undefined;
  right?: ReactNode | undefined;
}) {
  return (
    <div className="ad-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="ad-sub">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
  hero = false,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode | undefined;
  hero?: boolean;
  tone?: "warn" | "down" | "up" | undefined;
}) {
  return (
    <div className={`ad-kpi${hero ? " hero" : ""}`}>
      <span className="ad-kpi-lab">{label}</span>
      <span className={`ad-kpi-val num${tone ? ` ad-${tone}` : ""}`}>{value}</span>
      {sub ? <span className="ad-kpi-sub">{sub}</span> : null}
    </div>
  );
}

/** Etiqueta a la izquierda, valor a la derecha. `null` en el valor = encabezado de grupo. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="ad-kv">
      {rows.map(([k, v], i) =>
        v === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista fija.
          <dt className="ad-kv-group" key={i}>
            {k}
          </dt>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista fija.
          <div key={i} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

export function Card({
  title,
  right,
  children,
  id,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="ad-card" id={id}>
      {title || right ? (
        <div className="ad-card-head">
          {title ? <h2 className="ad-h2">{title}</h2> : <span />}
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string | undefined }) {
  return <span className={`ad-b${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

/** Barras: el embudo, los niveles. `note` va debajo de la barra. */
export function Bars({
  rows,
}: {
  rows: { label: string; value: number; max: number; note?: ReactNode; tone?: string }[];
}) {
  return (
    <div className="ad-bars">
      {rows.map((r) => (
        <div className="ad-bar-row" key={r.label}>
          <span className="ad-bar-l">{r.label}</span>
          <span className="ad-bar-v">{r.value}</span>
          <span className="ad-bar" aria-hidden="true">
            <i
              className={r.tone}
              style={{ width: `${r.max ? Math.min(100, (100 * r.value) / r.max) : 0}%` }}
            />
          </span>
          {r.note ? <span className="ad-bar-n">{r.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** ✓ / ? / ✕ de una lista de requisitos. */
export function Checks({ rows }: { rows: { state: "y" | "n" | "q"; text: ReactNode }[] }) {
  return (
    <ul className="ad-checks">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lista fija.
        <li key={i}>
          <span className={`ad-ck ${r.state}`} aria-hidden="true">
            {r.state === "y" ? "✓" : r.state === "n" ? "✕" : "?"}
          </span>
          <span>
            <span className="sr-only">
              {r.state === "y" ? "Listo: " : r.state === "n" ? "Falta: " : "Revísalo: "}
            </span>
            {r.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Banner de ?ok= / ?error= arriba de cada sección. */
export function Banner({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (ok)
    return (
      <div className="ad-alert ok" role="status">
        <span aria-hidden="true">✓</span>
        <span>{ok}</span>
      </div>
    );
  if (error)
    return (
      <div className="ad-alert red" role="alert">
        <span aria-hidden="true">!</span>
        <span>{error}</span>
      </div>
    );
  return null;
}
