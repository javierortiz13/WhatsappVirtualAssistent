import type { TenantRow } from "@/lib/admin";
import { type ClientFilters, filtersHref, SORTS, STATE_FILTERS, type StateFilter } from "../derive";
import { STATE } from "../format";
import { Banner, Head } from "../ui/bits";
import { ClientRow } from "./client-row";

export type ClientesData = {
  banner: { ok: string | null; error: string | null };
  list: TenantRow[];
  total: number;
  filters: ClientFilters;
  counts: Record<StateFilter, number>;
};

const PLAN_OPTS = [
  ["todos", "Todos"],
  ["personal", "Personal"],
  ["negocio", "Negocio"],
  ["negocio_plus", "Plus"],
] as const;
const LAST_OPTS = [
  ["todos", "Cualquier actividad", ""],
  ["green", "Al día", "ok"],
  ["amber", "3+ días", "warn"],
  ["red", "7+ días", "late"],
] as const;
const SORT_LABEL: Record<(typeof SORTS)[number], string> = {
  vence: "Vence primero",
  ultimo: "Más días sin escribir",
  margen: "Menor margen",
  tope: "Más cerca del tope",
};

/**
 * /admin/clientes: la lista de negocios con los filtros en la URL (?q=, plan, estado, ultimo,
 * orden, internas). Cada filtro es un enlace: funciona sin JavaScript y se puede compartir.
 */
export function ClientesView(d: ClientesData) {
  const f = d.filters;
  const toggle = (s: StateFilter) =>
    f.estados.includes(s) ? f.estados.filter((x) => x !== s) : [...f.estados, s];
  const any = f.q || f.plan !== "todos" || f.estados.length || f.ultimo !== "todos";
  return (
    <>
      <Head title="Clientes" sub={`${d.total} negocios y cuentas personales`} />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      <div className="ad-filters">
        <form className="ad-search" method="get" action="/admin/clientes">
          <span aria-hidden="true" style={{ color: "var(--muted)" }}>
            ⌕
          </span>
          <input
            type="search"
            name="q"
            defaultValue={f.q}
            placeholder="Buscar por nombre"
            aria-label="Buscar cliente por nombre"
          />
          {f.plan !== "todos" ? <input type="hidden" name="plan" value={f.plan} /> : null}
          {f.estados.length ? (
            <input type="hidden" name="estado" value={f.estados.join(",")} />
          ) : null}
          {f.ultimo !== "todos" ? <input type="hidden" name="ultimo" value={f.ultimo} /> : null}
          {f.orden !== "vence" ? <input type="hidden" name="orden" value={f.orden} /> : null}
          {f.internas ? <input type="hidden" name="internas" value="1" /> : null}
          <button className="ad-btn" type="submit">
            Buscar
          </button>
        </form>
        <nav className="ad-seg" aria-label="Plan">
          {PLAN_OPTS.map(([v, label]) => (
            <a
              key={v}
              href={filtersHref(f, { plan: v })}
              aria-current={f.plan === v ? "true" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <nav className="ad-chips" aria-label="Estado (puedes elegir varios)">
          {STATE_FILTERS.map((s) => (
            <a
              key={s}
              className="ad-chip"
              href={filtersHref(f, { estados: toggle(s) })}
              aria-current={f.estados.includes(s) ? "true" : undefined}
            >
              {STATE[s].label} <span className="n">{d.counts[s]}</span>
            </a>
          ))}
        </nav>
        <nav className="ad-chips" aria-label="Último mensaje">
          {LAST_OPTS.map(([v, label, dot]) => (
            <a
              key={v}
              className="ad-chip"
              href={filtersHref(f, { ultimo: v })}
              aria-current={f.ultimo === v ? "true" : undefined}
            >
              {dot ? <span className={`ad-dot ${dot}`} aria-hidden="true" /> : null}
              {label}
            </a>
          ))}
        </nav>
        <nav className="ad-chips" aria-label="Orden">
          {SORTS.map((s) => (
            <a
              key={s}
              className="ad-chip"
              href={filtersHref(f, { orden: s })}
              aria-current={f.orden === s ? "true" : undefined}
            >
              {SORT_LABEL[s]}
            </a>
          ))}
        </nav>
        <nav className="ad-chips" aria-label="Cuentas internas">
          <a
            className="ad-chip"
            href={filtersHref(f, { internas: !f.internas })}
            aria-current={f.internas ? "true" : undefined}
          >
            Mostrar cuentas internas
          </a>
        </nav>
      </div>
      <p className="ad-note" aria-live="polite">
        {d.list.length} {d.list.length === 1 ? "resultado" : "resultados"}
      </p>
      <div className="ad-list">
        {d.list.length ? (
          d.list.map((t) => <ClientRow key={t.id} t={t} />)
        ) : (
          <div className="ad-empty">
            Ningún cliente con esos filtros.{" "}
            {any ? (
              <a href={filtersHref(f, { q: "", plan: "todos", estados: [], ultimo: "todos" })}>
                Quitar filtros
              </a>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
