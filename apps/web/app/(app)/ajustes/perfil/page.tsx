import { tenantPhones } from "@caja/core";
import { eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { formatE164 } from "@/lib/phone";
import { requireTenant } from "@/lib/session";
import { IconChevronLeft, IconLogout } from "../../icons";
import { updateProfileAction } from "../cuenta-actions";

export const metadata: Metadata = { title: "Perfil" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  nombre: "Escribe un nombre de 1 a 60 caracteres.",
  servidor: "No pudimos guardar el cambio. Inténtalo en unos minutos.",
};

/** Perfil de la cuenta: nombre (también es como te llama el asistente), correo y número. */
export default async function Perfil({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { user, tenant } = await requireTenant();
  const sp = await searchParams;
  const [account] = await db()
    .select({ name: schema.userAccount.name })
    .from(schema.userAccount)
    .where(eq(schema.userAccount.id, user.id));
  const phones = await withTenant(db(), tenant.id, (tx) => tenantPhones(tx, tenant.id));
  const owner = phones.find((p) => p.role === "owner");
  const name = account?.name ?? owner?.displayName ?? "";
  const support = env().SUPPORT_HINT;
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {sp.ok ? <div className="notice ok">Listo, guardamos tu nombre.</div> : null}
      {sp.error ? <div className="notice err">{ERRORS[sp.error] ?? sp.error}</div> : null}

      <section className="card rate">
        <span className="avatar lg">{(name || user.email).charAt(0).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name || "Sin nombre"}
          </h2>
          <p className="sub" style={{ margin: 0 }}>
            {tenant.name}
          </p>
        </div>
      </section>

      <form action={updateProfileAction} className="card stack-sm">
        <label className="field">
          <span>Tu nombre</span>
          <input className="input" name="name" defaultValue={name} maxLength={60} required />
        </label>
        <p className="hint">Así te saluda el asistente por WhatsApp.</p>
        <button className="btn block" type="submit">
          Guardar
        </button>
      </form>

      <section className="card tight">
        <div className="row">
          <span className="what">
            <strong>Correo</strong>
            <span className="sub">{user.email}</span>
          </span>
        </div>
        <p className="sub admin-pad">
          Es tu forma de entrar al dashboard.{" "}
          {support ? `Para cambiarlo escríbenos: ${support}.` : "Para cambiarlo escríbenos."}
        </p>
        <a className="row" href="/ajustes/numeros">
          <span className="what">
            <strong>Tu número de WhatsApp</strong>
            <span className="sub num">{owner ? formatE164(owner.e164) : "sin número"}</span>
          </span>
          <span className="sub">Ver números</span>
        </a>
      </section>

      <form action="/auth/logout" method="post">
        <button className="btn secondary block" type="submit">
          <IconLogout size={16} />
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
