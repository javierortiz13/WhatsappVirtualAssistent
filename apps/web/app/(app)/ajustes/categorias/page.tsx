import { listCategories } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { createCategoryAction, renameCategoryAction, setCategoryActiveAction } from "./actions";

export const metadata: Metadata = { title: "Categorías" };
export const dynamic = "force-dynamic";

const MSG: Record<string, string> = {
  creada: "Categoría creada. El asistente ya la puede sugerir.",
  guardada: "Nombre guardado.",
  duplicate: "Ya existe una categoría con ese nombre.",
  invalid: "El nombre debe tener entre 2 y 40 caracteres.",
  missing: "Esa categoría ya no existe.",
  permiso: "Solo el dueño puede cambiar las categorías.",
  servidor: "No pudimos guardar el cambio. Inténtalo en unos minutos.",
};

/** Categorías de gasto (US-E5): crear, renombrar, desactivar. No se borran si tienen movimientos. */
export default async function Categorias({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const list = await withTenant(db(), tenant.id, (tx) => listCategories(tx, tenant.id));
  const active = list.filter((c) => c.isActive);
  const inactive = list.filter((c) => !c.isActive);
  const isOwner = tenant.role === "owner";
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <a href="/ajustes">← Ajustes</a>
      </p>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Categorías de gasto</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          El asistente clasifica cada gasto en una de estas. Una categoría desactivada deja de
          sugerirse, pero sus gastos conservan el nombre.
        </p>
        <ul className="list">
          {active.map((c) => (
            <li key={c.id}>
              {isOwner ? (
                <form
                  action={renameCategoryAction}
                  className="title"
                  style={{ display: "flex", gap: 8 }}
                >
                  <input type="hidden" name="id" value={c.id} />
                  <input
                    className="input"
                    name="name"
                    defaultValue={c.name}
                    maxLength={40}
                    required
                    aria-label="Nombre"
                  />
                  <button className="btn secondary small" type="submit">
                    Guardar
                  </button>
                </form>
              ) : (
                <span className="title">{c.name}</span>
              )}
              <span className="meta">
                {c.movements === 0
                  ? "sin gastos"
                  : c.movements === 1
                    ? "1 gasto"
                    : `${c.movements} gastos`}
              </span>
              {isOwner ? (
                <form action={setCategoryActiveAction} className="amt2">
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="active" value="0" />
                  <button className="btn secondary small" type="submit">
                    Desactivar
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <form action={createCategoryAction} className="stack">
            <p className="kpi-label" style={{ margin: 0 }}>
              Nueva categoría
            </p>
            <input
              className="input"
              name="name"
              maxLength={40}
              placeholder="Ej. Publicidad"
              required
            />
            <button className="btn secondary" type="submit">
              Agregar
            </button>
          </form>
        ) : null}
      </div>
      {inactive.length ? (
        <div className="card stack">
          <p className="kpi-label" style={{ margin: 0 }}>
            Desactivadas
          </p>
          <ul className="list">
            {inactive.map((c) => (
              <li key={c.id}>
                <span className="title muted">{c.name}</span>
                <span className="meta">{c.movements} gastos</span>
                {isOwner ? (
                  <form action={setCategoryActiveAction} className="amt2">
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="active" value="1" />
                    <button className="btn secondary small" type="submit">
                      Reactivar
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
