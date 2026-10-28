import { dashboardMembers } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { IconChevronLeft, IconUser } from "../../icons";
import { removeMemberAction } from "./actions";

export const metadata: Metadata = { title: "Acceso al panel" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  datos: "No encontramos ese acceso. Recarga la página.",
  permiso: "Solo el dueño puede quitar accesos.",
};

/** Quién entra a este panel con su correo, y «Quitar acceso» (seguridad F3). */
export default async function AccesoPanel({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { user, tenant } = await requireTenant();
  const sp = await searchParams;
  const members = await withTenant(db(), tenant.id, (tx) => dashboardMembers(tx, tenant.id));
  const isOwner = tenant.role === "owner";
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {sp.error ? <div className="notice err">{ERRORS[sp.error] ?? ERRORS.datos}</div> : null}
      {sp.ok === "quitado" ? (
        <div className="notice ok">Listo. Esa persona ya no puede entrar a tu panel.</div>
      ) : null}
      <p className="sub" style={{ margin: 0 }}>
        Estas personas entran a tu panel con su correo y pueden ver y cambiar todos tus movimientos.
      </p>
      <div className="card tight">
        {members.map((m) => (
          <div className="row" key={m.userId}>
            <span className="ico lg">
              <IconUser />
            </span>
            <span className="what">
              <strong>{m.email}</strong>
              <span className="sub">{m.userId === user.id ? "Tú" : "Dueño"}</span>
            </span>
            {isOwner && m.userId !== user.id ? (
              <form action={removeMemberAction}>
                <input type="hidden" name="user_id" value={m.userId} />
                <button className="linkbtn" type="submit">
                  Quitar acceso
                </button>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
