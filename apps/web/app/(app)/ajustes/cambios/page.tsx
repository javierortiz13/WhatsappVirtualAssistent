import { Decimal, exchangeLots, formatMoney, getBsRateMode, listAccounts } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { IconChevronDown, IconChevronLeft, IconSwap } from "../../icons";
import { createExchangeAction, deleteExchangeAction } from "./actions";

export const metadata: Metadata = { title: "Cambios USDT" };
export const dynamic = "force-dynamic";

const MSG: Record<string, string> = {
  creado: "Cambio guardado. Tus próximos gastos en Bs salen de aquí.",
  borrado: "Cambio borrado.",
  datos: "Escribe los USDT y la tasa, o los USDT y los Bs que te dieron.",
  fecha: "La fecha no puede ser futura.",
  tasa: "Esa tasa está muy lejos de la BCV. Revisa los montos: 49.250 son cuarenta y nueve mil bolívares.",
  usado: "Ese cambio ya pagó gastos: borra o corrige esos gastos primero.",
  permiso: "Solo el dueño puede registrar cambios.",
  servidor: "No pudimos guardar el cambio. Inténtalo en unos minutos.",
};

const MODE_TEXT: Record<"bcv" | "usdt" | "ask", string> = {
  bcv: "Tus gastos en Bs van a la tasa BCV. Para que salgan de estos cambios, elígelo en Negocio.",
  usdt: "Tus gastos en Bs salen de estos cambios, del más viejo al más nuevo.",
  ask: "Al registrar un gasto en Bs, el asistente te pregunta si salió de estos cambios o va a la BCV.",
};

const num = (v: Decimal.Value) => formatMoney(v, "VES").replace("Bs ", "");
/** Sin ",00" si es entero: "50 USDT a 985" cabe en una línea del teléfono. */
const short = (v: Decimal) => (v.isInteger() ? num(v).replace(/,00$/, "") : num(v));

/**
 * Cambios de USDT a bolívares (0012): cada cambio es un lote; los gastos en Bs salen del más viejo
 * con saldo y quedan en dólares a la tasa de ese cambio.
 */
export default async function Cambios({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const { lots, mode, accounts } = await withTenant(db(), tenant.id, async (tx) => ({
    // Solo los cambios: los lotes de ventas y saldos iniciales de las cuentas (0013) no van aquí.
    lots: await exchangeLots(tx, tenant.id, { source: "exchange" }),
    mode: await getBsRateMode(tx, tenant.id),
    accounts: await listAccounts(tx, tenant.id),
  }));
  const nameOf = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? null;
  const usdAccounts = accounts.filter((a) => a.currency === "USD");
  const vesAccounts = accounts.filter((a) => a.currency === "VES");
  // La de Binance primero para los USDT; el banco primero para los Bs.
  const fromDefault = usdAccounts.find((a) => a.kind === "crypto") ?? usdAccounts[0];
  const toDefault = vesAccounts.find((a) => a.kind === "bank") ?? vesAccounts[0];
  const left = lots.reduce((s, l) => s.plus(l.vesRemaining), new Decimal(0));
  const isOwner = tenant.role === "owner";
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  const newestFirst = [...lots].reverse();
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      <section className="card stack">
        <span className="label">Te quedan de tus cambios</span>
        <p className="big num">{formatMoney(left, "VES")}</p>
        <p className="sub">
          {MODE_TEXT[mode]}{" "}
          <a className="inline-link" href="/ajustes/negocio">
            Cambiar
          </a>
        </p>
      </section>
      {isOwner ? (
        <form action={createExchangeAction} className="card stack">
          <h2>Registrar un cambio</h2>
          <p className="sub">
            Escribe los USDT y la tasa, o los USDT y los Bs que te dieron. También por el chat:{" "}
            <em>cambié 100 usdt a 970</em>.
          </p>
          <label className="field">
            <span>USDT que cambiaste</span>
            <input className="input center" name="usd" inputMode="decimal" placeholder="100" />
          </label>
          <label className="field">
            <span>Tasa (Bs por USDT)</span>
            <input className="input center" name="rate" inputMode="decimal" placeholder="970" />
          </label>
          <label className="field">
            <span>O los Bs que te dieron</span>
            <input className="input center" name="ves" inputMode="decimal" placeholder="97.000" />
          </label>
          {usdAccounts.length ? (
            <label className="field">
              <span>De la cuenta</span>
              <span className="sel">
                <select className="input" name="from_account" defaultValue={fromDefault?.id}>
                  {usdAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  <option value="">Ninguna</option>
                </select>
                <IconChevronDown size={16} />
              </span>
            </label>
          ) : null}
          {vesAccounts.length ? (
            <label className="field">
              <span>A la cuenta</span>
              <span className="sel">
                <select className="input" name="to_account" defaultValue={toDefault?.id}>
                  {vesAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  <option value="">Ninguna</option>
                </select>
                <IconChevronDown size={16} />
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>Fecha</span>
            <input
              className="input center"
              type="date"
              name="date"
              defaultValue={todayInCaracas()}
              max={todayInCaracas()}
              required
            />
          </label>
          <div className="center">
            <button className="btn" type="submit">
              Guardar cambio
            </button>
          </div>
        </form>
      ) : null}
      {newestFirst.length ? (
        <div className="card tight">
          {newestFirst.map((l) => (
            <div className="row" key={l.id}>
              <span className="ico lg">
                <IconSwap />
              </span>
              <span className="what">
                <strong>
                  {short(l.usdAmount)} USDT a {short(l.rate)}
                </strong>
                <span className="sub">
                  {formatMoney(l.vesAmount, "VES")} · {l.businessDate.slice(8, 10)}/
                  {l.businessDate.slice(5, 7)}
                  {l.accountId || l.fromAccountId
                    ? ` · ${nameOf(l.fromAccountId) ?? "—"} → ${nameOf(l.accountId) ?? "—"}`
                    : ""}
                </span>
              </span>
              <span className="amts">
                <strong className="num">{formatMoney(l.vesRemaining, "VES")}</strong>
                <span className="sub">
                  {l.vesRemaining.lt("0.01") ? "agotado" : l.used ? "quedan" : "sin usar"}
                </span>
                {isOwner && !l.used ? (
                  <form action={deleteExchangeAction}>
                    <input type="hidden" name="id" value={l.id} />
                    <button className="linkbtn" type="submit">
                      Borrar
                    </button>
                  </form>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="sub center-text">Todavía no has registrado cambios.</p>
      )}
    </div>
  );
}
