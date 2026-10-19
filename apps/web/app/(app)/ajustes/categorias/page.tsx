import {
  BUDGET_WARN_PCT,
  type BudgetStatus,
  budgetStatuses,
  ensureIncomeCategories,
  formatMoney,
  listCategories,
} from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { isPersonalTenant, requireTenant } from "@/lib/session";
import { IconChevronLeft, IconTags } from "../../icons";
import {
  createCategoryAction,
  renameCategoryAction,
  setBudgetAction,
  setCategoryActiveAction,
} from "./actions";

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
  presupuesto: "Presupuesto guardado. El asistente te dirá cuánto te queda al guardar cada gasto.",
  presupuesto_quitado: "Presupuesto quitado.",
  presupuesto_invalid: "Escribe el presupuesto en dólares, por ejemplo 200 o 150,50.",
  presupuesto_missing: "Esa categoría ya no existe.",
};

/** "Gastado $155,00 de $200,00 este mes · 77 %" con la barra en verde, ámbar o rojo. */
function BudgetBar({ b }: { b: BudgetStatus }) {
  const tone =
    b.remainingUsd.isNegative() || b.remainingUsd.isZero()
      ? "over"
      : b.pct >= BUDGET_WARN_PCT
        ? "warn"
        : "";
  const when = b.period === "monthly" ? "este mes" : "esta quincena";
  return (
    <div className="budget-status">
      <div className="usage" aria-hidden="true">
        <span style={{ width: `${Math.min(100, b.pct)}%` }} className={tone} />
      </div>
      <span className={`num ${tone === "over" ? "danger" : tone === "warn" ? "amber" : ""}`}>
        Gastado {formatMoney(b.spentUsd, "USD")} de {formatMoney(b.amountUsd, "USD")} {when} ·{" "}
        {b.pct} %
      </span>
    </div>
  );
}

const count = (n: number) => (n === 0 ? "sin gastos" : n === 1 ? "1 gasto" : `${n} gastos`);

/** Categorías de gasto (US-E5): crear, renombrar, desactivar. No se borran si tienen movimientos. */
export default async function Categorias({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const today = todayInCaracas();
  const personal = await isPersonalTenant(tenant.id);
  const [list, budgets, sources] = await withTenant(db(), tenant.id, async (tx) => {
    // Cuenta personal: sus fuentes de ingreso (se crean solas si aún no las tiene).
    if (personal) await ensureIncomeCategories(tx, tenant.id, "dashboard");
    return Promise.all([
      listCategories(tx, tenant.id),
      budgetStatuses(tx, tenant.id, today),
      personal ? listCategories(tx, tenant.id, "income") : Promise.resolve([]),
    ]);
  });
  const budgetOf = new Map(budgets.map((b) => [b.categoryId, b]));
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
      <p className="sub">
        El asistente clasifica cada gasto en una de estas. Una categoría desactivada deja de
        sugerirse, pero sus gastos conservan el nombre.
      </p>
      {isOwner ? (
        <p className="sub">
          <strong>Presupuesto:</strong> un tope en dólares, mensual o quincenal (del 1 al 15 y del
          16 al fin de mes). Al guardar un gasto Rocco te dice cuánto te queda. Déjalo vacío para
          quitarlo.
        </p>
      ) : null}
      <div className="card tight">
        {active.map((c) => (
          <div className="cat" key={c.id}>
            {isOwner ? (
              <form action={renameCategoryAction} className="edit">
                <input type="hidden" name="id" value={c.id} />
                <input
                  className="input"
                  name="name"
                  defaultValue={c.name}
                  maxLength={40}
                  required
                  aria-label="Nombre"
                />
                <button className="btn save small" type="submit">
                  Guardar
                </button>
              </form>
            ) : (
              <strong>{c.name}</strong>
            )}
            {isOwner ? (
              <form action={setBudgetAction} className="edit budget">
                <input type="hidden" name="id" value={c.id} />
                <label className="money">
                  <span aria-hidden="true">$</span>
                  <input
                    className="input"
                    name="amount"
                    inputMode="decimal"
                    defaultValue={budgetOf.get(c.id)?.amountUsd.toFixed(2) ?? ""}
                    placeholder="Monto"
                    aria-label={`Presupuesto de ${c.name} en dólares`}
                  />
                </label>
                <select
                  className="input"
                  name="period"
                  defaultValue={budgetOf.get(c.id)?.period ?? "monthly"}
                  aria-label="Período"
                >
                  <option value="monthly">Mensual</option>
                  <option value="biweekly">Quincenal</option>
                </select>
                <button className="btn save small" type="submit">
                  Guardar
                </button>
              </form>
            ) : null}
            {budgetOf.get(c.id) ? <BudgetBar b={budgetOf.get(c.id) as BudgetStatus} /> : null}
            <div className="foot">
              <span>
                {count(c.movements)} ·{" "}
                <a
                  className="linkbtn"
                  href={`/movimientos?mes=${today.slice(0, 7)}&tipo=expense&categoria=${c.id}`}
                >
                  Ver gastos del mes ›
                </a>
              </span>
              {isOwner ? (
                <form action={setCategoryActiveAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="active" value="0" />
                  <button className="linkbtn" type="submit">
                    Desactivar
                  </button>
                </form>
              ) : null}
            </div>
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
            aria-label="Nombre de la nueva categoría"
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
                    <button className="linkbtn" type="submit">
                      Reactivar
                    </button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {personal ? (
        <IncomeSources list={sources} isOwner={isOwner} month={today.slice(0, 7)} />
      ) : null}
    </div>
  );
}

/**
 * Fuentes de ingreso de una cuenta personal (19/10): salario, freelance, remesas… Rocco pone cada
 * ingreso en una; aquí se renombran, se agregan y se desactivan, igual que las de gasto.
 */
function IncomeSources({
  list,
  isOwner,
  month,
}: {
  list: Awaited<ReturnType<typeof listCategories>>;
  isOwner: boolean;
  month: string;
}) {
  const active = list.filter((c) => c.isActive);
  const inactive = list.filter((c) => !c.isActive);
  const n = (k: number) => (k === 0 ? "sin ingresos" : k === 1 ? "1 ingreso" : `${k} ingresos`);
  return (
    <>
      <div className="day">
        <h2>Fuentes de ingreso</h2>
      </div>
      <p className="sub">
        De dónde te entra la plata. Cuando le dices a Rocco &quot;me pagaron el sueldo&quot; o
        &quot;cobré un freelance&quot;, lo anota en la que corresponde.
      </p>
      <div className="card tight">
        {active.map((c) => (
          <div className="cat" key={c.id}>
            {isOwner ? (
              <form action={renameCategoryAction} className="edit">
                <input type="hidden" name="id" value={c.id} />
                <input
                  className="input"
                  name="name"
                  defaultValue={c.name}
                  maxLength={40}
                  required
                  aria-label="Nombre"
                />
                <button className="btn save small" type="submit">
                  Guardar
                </button>
              </form>
            ) : (
              <strong>{c.name}</strong>
            )}
            <div className="foot">
              <span>
                {n(c.movements)} ·{" "}
                <a
                  className="linkbtn"
                  href={`/movimientos?mes=${month}&tipo=income&categoria=${c.id}`}
                >
                  Ver ingresos del mes ›
                </a>
              </span>
              {isOwner ? (
                <form action={setCategoryActiveAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="active" value="0" />
                  <button className="linkbtn" type="submit">
                    Desactivar
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {isOwner ? (
        <form action={createCategoryAction} className="card stack">
          <h2>Nueva fuente de ingreso</h2>
          <input type="hidden" name="kind" value="income" />
          <input
            className="input center"
            name="name"
            maxLength={40}
            placeholder="Ej. Clases particulares"
            aria-label="Nombre de la nueva fuente de ingreso"
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
        <div className="card tight">
          {inactive.map((c) => (
            <div className="row" key={c.id}>
              <span className="what">
                <strong className="muted">{c.name}</strong>
                <span className="sub">{n(c.movements)}</span>
              </span>
              {isOwner ? (
                <form action={setCategoryActiveAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="active" value="1" />
                  <button className="linkbtn" type="submit">
                    Reactivar
                  </button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
