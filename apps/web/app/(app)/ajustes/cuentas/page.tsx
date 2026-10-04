import {
  ACCOUNT_KIND_LABELS,
  type AccountView,
  accountBalances,
  type Decimal,
  formatMoney,
  getRateInfo,
  netWorth,
} from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { IconChevronDown, IconChevronLeft, IconWallet } from "../../icons";
import {
  archiveAccountAction,
  createAccountAction,
  createTransferAction,
  updateAccountAction,
} from "./actions";

export const metadata: Metadata = { title: "Cuentas" };
export const dynamic = "force-dynamic";

const MSG: Record<string, string> = {
  creada: "Cuenta creada.",
  editada: "Cuenta actualizada.",
  archivada: "Cuenta archivada. Sus movimientos quedan como estaban.",
  datos: "Revisa el nombre y el tipo de la cuenta.",
  saldo: "No entendimos el saldo. Escríbelo así: 12.500 o 12.500,50.",
  repetida: "Ya tienes una cuenta con ese nombre.",
  tope: "Llegaste al máximo de cuentas. Archiva alguna para crear otra.",
  permiso: "Solo el dueño puede cambiar las cuentas.",
  servidor: "No pudimos guardar. Inténtalo en unos minutos.",
  transferida: "Transferencia guardada.",
  misma: "Elige dos cuentas distintas.",
  cambio: "De dólares a bolívares es un cambio: regístralo en Cambios USDT.",
  monto: "Revisa el monto: 12.500 o 12.500,50.",
  recibido: "Comprando USDT con Bs, escribe también los USDT que recibiste.",
  tasa: "Esa tasa está muy lejos de la BCV. Revisa los montos.",
  fecha: "La fecha no puede ser futura.",
};

/** "Bs 12.300,00", "$40,00" o "85,00 USDT". */
function money(a: Pick<AccountView, "currency" | "kind">, v: Decimal): string {
  if (a.currency === "USD" && a.kind === "crypto")
    return `${formatMoney(v, "USD").replace("$", "")} USDT`;
  return formatMoney(v, a.currency);
}

/** "Banco · Bs", "Efectivo · $", "USDT". */
function kindLine(a: Pick<AccountView, "currency" | "kind">): string {
  if (a.currency === "USD" && a.kind === "crypto") return "USDT";
  return `${ACCOUNT_KIND_LABELS[a.kind]} · ${a.currency === "VES" ? "Bs" : "$"}`;
}

/**
 * Cuentas (0013): dónde vive el dinero. Cada gasto o venta por el chat dice de qué cuenta salió
 * o a cuál entró; el total pasa los bolívares a dólares a la BCV de hoy.
 */
export default async function Cuentas({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const [accounts, rate] = await Promise.all([
    withTenant(db(), tenant.id, (tx) => accountBalances(tx, tenant.id)),
    getRateInfo(db(), todayInCaracas()),
  ]);
  const bcv = rate.current?.value ?? null;
  const nw = netWorth(accounts, bcv);
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
      {accounts.length ? (
        <section className="card stack">
          <span className="label">Tienes en total</span>
          <p className="big num">
            {nw.totalUsd !== null ? formatMoney(nw.totalUsd, "USD") : formatMoney(nw.usd, "USD")}
          </p>
          <p className="sub">
            {formatMoney(nw.usd, "USD")} en dólares y {formatMoney(nw.ves, "VES")}
            {bcv ? ` a la BCV de hoy (${formatMoney(bcv, "VES").replace("Bs ", "")})` : ""}.
          </p>
        </section>
      ) : (
        <section className="card stack">
          <h2>¿Dónde tienes tu dinero?</h2>
          <p className="sub">
            Crea una cuenta por cada lugar: tu banco en bolívares, Binance, Zelle, el efectivo.
            Cuando registres un gasto o una venta por el chat, el asistente sabe de qué cuenta salió
            (<em>pagué 500 Bs de luz con Banesco</em>, <em>me pagaron 30$ por Zelle</em>) y te dice
            cuánto te queda en cada una.
          </p>
          <p className="sub">Son opcionales: sin cuentas todo sigue igual.</p>
        </section>
      )}
      {accounts.length ? (
        <div className="card tight">
          {accounts.map((a) => (
            <a className="row" key={a.id} href={`/ajustes/cuentas/${a.id}`}>
              <span className="ico lg">
                <IconWallet />
              </span>
              <span className="what">
                <strong>{a.name}</strong>
                <span className="sub">{kindLine(a)}</span>
              </span>
              <span className="amts">
                <strong className={`num ${a.balance.isNegative() ? "neg" : ""}`}>
                  {money(a, a.balance)}
                </strong>
              </span>
            </a>
          ))}
        </div>
      ) : null}
      {isOwner && accounts.length >= 2 ? (
        <form action={createTransferAction} className="card stack">
          <h2>Pasar dinero entre cuentas</h2>
          <p className="sub">
            No es gasto ni venta: solo cambia dónde está el dinero. También por el chat:{" "}
            <em>pasé 100$ de Zelle a Binance</em>, <em>compré 50 usdt con 49.000 bs</em>.
          </p>
          <label className="field">
            <span>De</span>
            <span className="sel">
              <select className="input" name="from" defaultValue={accounts[0]?.id}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({kindLine(a).split(" · ").pop()})
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
          <label className="field">
            <span>A</span>
            <span className="sel">
              <select className="input" name="to" defaultValue={accounts[1]?.id}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({kindLine(a).split(" · ").pop()})
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
          <label className="field">
            <span>Monto que salió</span>
            <input
              className="input center"
              name="amount"
              inputMode="decimal"
              placeholder="100"
              required
            />
          </label>
          <label className="field">
            <span>Lo que llegó, si es otra moneda</span>
            <input
              className="input center"
              name="received"
              inputMode="decimal"
              placeholder="Comprando USDT: los USDT"
            />
          </label>
          <label className="field">
            <span>Comisión (opcional)</span>
            <input className="input center" name="fee" inputMode="decimal" placeholder="0" />
            <span className="sub">Queda como gasto de la cuenta de origen.</span>
          </label>
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
              Transferir
            </button>
          </div>
        </form>
      ) : null}
      {isOwner && accounts.length ? (
        <details className="card stack">
          <summary>
            <strong>Editar o archivar</strong>
          </summary>
          {accounts.map((a) => (
            <div className="stack" key={a.id}>
              <form action={updateAccountAction} className="stack">
                <input type="hidden" name="id" value={a.id} />
                <label className="field">
                  <span>Nombre</span>
                  <input className="input" name="name" defaultValue={a.name} maxLength={40} />
                </label>
                <label className="field">
                  <span>
                    Saldo inicial (
                    {a.currency === "VES" ? "Bs" : a.kind === "crypto" ? "USDT" : "$"})
                  </span>
                  <input
                    className="input center"
                    name="opening"
                    inputMode="decimal"
                    defaultValue={a.openingBalance.toFixed(2).replace(".", ",")}
                  />
                  <span className="sub">
                    Lo que tenías el {a.openingDate.slice(8, 10)}/{a.openingDate.slice(5, 7)}, al
                    crearla.
                  </span>
                </label>
                <div className="center">
                  <button className="btn secondary small" type="submit">
                    Guardar {a.name}
                  </button>
                </div>
              </form>
              <form action={archiveAccountAction} className="center">
                <input type="hidden" name="id" value={a.id} />
                <button className="linkbtn" type="submit">
                  Archivar {a.name}
                </button>
              </form>
            </div>
          ))}
        </details>
      ) : null}
      {isOwner ? (
        <form action={createAccountAction} className="card stack">
          <h2>Nueva cuenta</h2>
          <label className="field">
            <span>Nombre</span>
            <input className="input" name="name" placeholder="Banesco" maxLength={40} required />
          </label>
          <label className="field">
            <span>Moneda</span>
            <span className="sel">
              <select className="input" name="currency" defaultValue="VES">
                <option value="VES">Bolívares</option>
                <option value="USD">Dólares</option>
                <option value="USDT">USDT (Binance)</option>
              </select>
              <IconChevronDown size={16} />
            </span>
          </label>
          <label className="field">
            <span>Tipo</span>
            <span className="sel">
              <select className="input" name="kind" defaultValue="bank">
                {Object.entries(ACCOUNT_KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} />
            </span>
            <span className="sub">
              El asistente usa el tipo para elegir la cuenta: pago móvil y punto van al banco,
              efectivo al efectivo.
            </span>
          </label>
          <label className="field">
            <span>Lo que tienes hoy en ella</span>
            <input className="input center" name="opening" inputMode="decimal" placeholder="0" />
            <span className="sub">
              En bolívares, ese saldo queda valorado a la BCV de hoy para tus gastos.
            </span>
          </label>
          <div className="center">
            <button className="btn" type="submit">
              Crear cuenta
            </button>
          </div>
        </form>
      ) : null}
      {accounts.length ? (
        <p className="sub center-text">
          La primera de cada moneda es la principal: si en el chat no dices de dónde pagaste, sale
          de ahí.
        </p>
      ) : null}
    </div>
  );
}
