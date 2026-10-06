import { businessDateOf, formatShortDate } from "@caja/core/domain";
import { eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { currentSession } from "@/lib/session";
import { restoreMyBusinessAction } from "./actions";

export const metadata: Metadata = { title: "Recuperar cuenta" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  permiso: "Solo el dueño puede recuperar la cuenta.",
  servidor: "No pudimos recuperarla. Inténtalo en unos minutos.",
};

/** Negocio en la papelera (0017): hasta cuándo y, para el dueño, el botón para recuperarlo. */
export default async function Recuperar({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const t = session.tenant;
  if (!t) redirect("/registro");
  if (t.status !== "deleted") redirect("/inicio");
  const sp = await searchParams;
  const [row] = await withTenant(db(), t.id, (tx) =>
    tx
      .select({ purgeAfter: schema.tenant.purgeAfter, reason: schema.tenant.deletionReason })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, t.id)),
  );
  const when = row?.purgeAfter ? formatShortDate(businessDateOf(row.purgeAfter)) : null;
  const owner = t.role === "owner";
  return (
    <main className="auth">
      <section className="auth-panel">
        <div className="card auth-card">
          <div>
            <h2>Tu cuenta está en la papelera</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              <strong>{t.name}</strong>
              {row?.reason === "unpaid"
                ? " pasó a la papelera porque el plan llevaba 90 días vencido."
                : " está en la papelera."}{" "}
              {when ? `Se borra para siempre el ${when}.` : "Se borra para siempre pronto."}
            </p>
          </div>
          {sp.error && ERRORS[sp.error] ? (
            <div className="notice err">{ERRORS[sp.error]}</div>
          ) : null}
          {owner ? (
            <form action={restoreMyBusinessAction}>
              <button className="btn block" type="submit">
                Recuperar mi cuenta
              </button>
            </form>
          ) : (
            <p className="sub">Solo el dueño puede recuperarla. Avísale si fue un error.</p>
          )}
          <p className="sub" style={{ margin: 0 }}>
            Todo sigue como estaba hasta esa fecha: movimientos, cuentas, fotos y números.
            {row?.reason === "unpaid"
              ? " Al recuperarla, renueva el plan para volver a usarla."
              : ""}
          </p>
          <form action="/auth/logout" method="post">
            <button className="btn secondary block" type="submit">
              Salir
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
