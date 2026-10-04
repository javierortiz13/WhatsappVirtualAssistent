import { type AccountView, accountStatement, type Decimal, es, formatMoney } from "@caja/core";
import { type IsoDate, monthNameEs } from "@caja/core/domain";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { monthBounds, todayInCaracas } from "@/lib/queries";
import { requireTenant } from "@/lib/session";
import { IconArrowDown, IconArrowUp, IconChevronLeft, IconSwap, IconWallet } from "../../../icons";
import { deleteTransferAction } from "../actions";

export const metadata: Metadata = { title: "Estado de cuenta" };
export const dynamic = "force-dynamic";

const MSG: Record<string, string> = {
  borrada: "Transferencia borrada.",
  usada: "Esos Bs ya pagaron gastos en la otra cuenta: borra o mueve esos gastos primero.",
  permiso: "Solo el dueño puede borrar transferencias.",
  datos: "No encontramos esa transferencia.",
  servidor: "No pudimos borrar. Inténtalo en unos minutos.",
};

function money(a: Pick<AccountView, "currency" | "kind">, v: Decimal): string {
  if (a.currency === "USD" && a.kind === "crypto")
    return `${formatMoney(v, "USD").replace("$", "")} USDT`;
  return formatMoney(v, a.currency);
}

function iconFor(kind: string, isIn: boolean) {
  if (kind === "opening") return <IconWallet />;
  if (kind.startsWith("transfer") || kind.startsWith("exchange")) return <IconSwap />;
  return isIn ? <IconArrowUp /> : <IconArrowDown />;
}

const dayMonth = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/**
 * Estado de cuenta (0014): cada cosa que movió la cuenta con el saldo después, como el extracto
 * del banco. Arriba, lo que entró y salió este mes.
 */
export default async function EstadoDeCuenta({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant } = await requireTenant();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const month = monthBounds(todayInCaracas() as IsoDate);
  const st = await withTenant(db(), tenant.id, (tx) =>
    accountStatement(tx, tenant.id, id, { limit: 100, from: month.from, to: month.to }),
  );
  if (!st) notFound();
  const a = st.account;
  const isOwner = tenant.role === "owner";
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes/cuentas" aria-label="Volver a cuentas">
          <IconChevronLeft />
        </a>
        <span className="sub">Cuentas</span>
      </div>
      {notice ? <div className={`notice ${sp.error ? "err" : "ok"}`}>{notice}</div> : null}
      <section className="card stack">
        <span className="label">{a.name}</span>
        <p className={`big num ${a.balance.isNegative() ? "neg" : ""}`}>{money(a, a.balance)}</p>
        <p className="sub">
          {monthNameEs(month.from)}: entró {money(a, st.period.in)} · salió {money(a, st.period.out)}
        </p>
      </section>
      <div className="card tight">
        {st.entries.map((e, i) => {
          const isIn = e.amount.isPositive() && !e.amount.isZero();
          const icon = iconFor(e.kind, isIn);
          const extra =
            e.kind.startsWith("exchange") && e.usd && e.rate
              ? ` · ${e.usd.toFixed(2).replace(".", ",")} USDT a ${e.rate.toFixed(2).replace(".", ",")}`
              : e.kind.startsWith("transfer") && e.usd
                ? // Compra de USDT con Bs: del lado del banco, los USDT; del lado de Binance, los Bs.
                  a.currency === "VES"
                  ? ` · ${e.usd.toFixed(2).replace(".", ",")} USDT`
                  : ` · ${formatMoney(e.usd, "VES")}`
                : "";
          const body = (
            <>
              <span className="ico lg">{icon}</span>
              <span className="what">
                <strong>{es.statementLabel({ ...e, amount: e.amount.toString() })}</strong>
                <span className="sub">
                  {dayMonth(e.date)}
                  {extra} · saldo {money(a, e.balanceAfter)}
                </span>
              </span>
              <span className="amts">
                <strong className={`num ${e.amount.isNegative() ? "neg" : ""}`}>
                  {e.kind === "opening" ? "" : isIn ? "+" : "−"}
                  {money(a, e.amount.abs())}
                </strong>
                {isOwner && e.transferId ? (
                  <form action={deleteTransferAction}>
                    <input type="hidden" name="id" value={e.transferId} />
                    <input type="hidden" name="back" value={a.id} />
                    <button className="linkbtn" type="submit">
                      Borrar
                    </button>
                  </form>
                ) : null}
              </span>
            </>
          );
          const key = `${e.kind}-${e.movementId ?? e.transferId ?? e.lotId ?? i}`;
          return e.movementId ? (
            <a className="row" key={key} href={`/movimientos/${e.movementId}`}>
              {body}
            </a>
          ) : (
            <div className="row" key={key}>
              {body}
            </div>
          );
        })}
      </div>
      {st.entries.length >= 100 ? (
        <p className="sub center-text">Se muestran las últimas 100 líneas.</p>
      ) : null}
    </div>
  );
}
