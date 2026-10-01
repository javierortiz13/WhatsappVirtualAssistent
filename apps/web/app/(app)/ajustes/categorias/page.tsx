import { listCategories } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { IconChevronLeft, IconTags } from "../../icons";
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

const count = (n: number) => (n === 0 ? "sin gastos" : n === 1 ? "1 gasto" : `${n} gastos`);

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
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      <p className="sub" style={{ margin: 0 }}>
        El asistente clasifica cada gasto en una de estas. Una categoría desactivada deja de
        sugerirse, pero sus gastos conservan el nombre.
      </p>
      <div className="card tight">
        {active.map((c) => (
          <div className="row" key={c.id}>
            <span className="ico lg" style={{ color: "var(--amber)" }}>
              <IconTags />
            </span>
            {isOwner ? (
              <form
                action={renameCategoryAction}
                className="what"
                style={{ flexDirection: "row", gap: 8 }}
              >
                <input type="hidden" name="id" value={c.id} />
                <input
                  className="input"
                  name="name"
                  defaultValue={c.name}
                  maxLength={40}
                  required
                  aria-label="Nombre"
                  style={{ height: 40 }}
                />
                <button className="btn secondary small" type="submit">
                  Guardar
                </button>
              </form>
            ) : (
              <span className="what">
                <strong>{c.name}</strong>
              </span>
            )}
            <span className="amts" style={{ gap: 6 }}>
              <span className="sub">{count(c.movements)}</span>
              {isOwner ? (
                <form action={setCategoryActiveAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="active" value="0" />
                  <button className="btn secondary small" type="submit">
                    Desactivar
                  </button>
                </form>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {isOwner ? (
        <form action={createCategoryAction} className="card stack">
          <h2>Nueva categoría</h2>
          <input
            className="input center"
            name="name"
            maxLength={40}
            placeholder="Ej. Publicidad"
            required
          />
          <div className="center">
            <button className="btn" type="submit">
              Agregar
            </button>
          </div>
        </form>
      ) : null}
      {inactive.length ? (
        <>
          <div className="day">
            <span className="label">Desactivadas</span>
          </div>
          <div className="card tight">
            {inactive.map((c) => (
              <div className="row" key={c.id}>
                <span className="ico lg" style={{ color: "var(--muted)" }}>
                  <IconTags />
                </span>
                <span className="what">
                  <strong className="muted">{c.name}</strong>
                  <span className="sub">{count(c.movements)}</span>
                </span>
                {isOwner ? (
                  <form action={setCategoryActiveAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="active" value="1" />
                    <button className="btn secondary small" type="submit">
                      Reactivar
                    </button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
