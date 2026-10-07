import { type TenantPhone, tenantPhones } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { COUNTRY_CODES, formatE164 } from "@/lib/phone";
import { requireTenant } from "@/lib/session";
import { IconChevronDown, IconChevronLeft, IconPhone } from "../../icons";
import { addEmployeeAction, setPhoneStatusAction } from "../actions";

export const metadata: Metadata = { title: "Números de WhatsApp" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  datos: "Revisa los datos del formulario.",
  telefono: "Ese número no se ve bien. Escríbelo sin el código de país, por ejemplo 412 1234567.",
  ocupado: "Ese número ya pertenece a otro negocio.",
  permiso: "Solo el dueño puede cambiar los números.",
  servidor: "No pudimos guardar el cambio. Inténtalo en unos minutos.",
};

const STATUS: Record<TenantPhone["status"], { label: string; cls: string }> = {
  active: { label: "activo", cls: "ok" },
  pending: { label: "sin vincular", cls: "warn" },
  disabled: { label: "desactivado", cls: "" },
};

/** Números que pueden escribirle al asistente (US-A4): el dueño y sus empleados. */
export default async function Numeros({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const phones = await withTenant(db(), tenant.id, (tx) => tenantPhones(tx, tenant.id));
  const owner = phones.find((p) => p.role === "owner");
  const isOwner = tenant.role === "owner";
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {sp.error ? (
        <div className="notice err">
          {ERRORS[sp.error] ?? "No pudimos guardar el cambio. Inténtalo de nuevo."}
        </div>
      ) : null}
      {sp.ok === "alta" ? (
        <div className="notice ok">
          Listo. Cuando ese número le escriba a Rocco por primera vez, recibe la bienvenida y ya
          puede registrar gastos y ventas.
        </div>
      ) : null}
      {owner?.status === "pending" ? (
        <div className="notice err">
          Tu número todavía no está vinculado. <a href="/registro">Vincúlalo aquí</a> para poder
          escribirle a Rocco.
        </div>
      ) : null}
      <div className="card tight">
        {phones.map((p) => (
          <div className="row" key={p.id}>
            <span
              className="ico lg"
              style={{ color: p.status === "active" ? "var(--mint)" : "var(--muted)" }}
            >
              <IconPhone />
            </span>
            <span className="what">
              <strong>{p.displayName ?? (p.role === "owner" ? "Dueño" : "Empleado")}</strong>
              <span className="sub num">
                {formatE164(p.e164)} · {p.role === "owner" ? "dueño" : "empleado"}
              </span>
            </span>
            <span className="amts" style={{ gap: 6 }}>
              <span className={`badge ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
              {isOwner && p.role === "employee" ? (
                <form action={setPhoneStatusAction}>
                  <input type="hidden" name="phone_id" value={p.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={p.status === "disabled" ? "active" : "disabled"}
                  />
                  <button className="linkbtn" type="submit">
                    {p.status === "disabled" ? "Reactivar" : "Desactivar"}
                  </button>
                </form>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {isOwner ? (
        <form action={addEmployeeAction} className="card stack">
          <h2>Agregar un empleado</h2>
          <div className="phone-row">
            <span className="sel">
              <select className="input" name="country" defaultValue="58" aria-label="País">
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <IconChevronDown size={16} />
            </span>
            <input
              className="input num"
              name="phone"
              required
              inputMode="tel"
              placeholder="412 1234567"
              aria-label="Número"
            />
          </div>
          <input
            className="input"
            name="name"
            maxLength={60}
            placeholder="Nombre (opcional)"
            aria-label="Nombre del empleado (opcional)"
          />
          <p className="sub">
            El empleado registra gastos y ventas; los cierres los ves solo tú. No necesita código:
            con escribirle a Rocco queda activo.
          </p>
          <div className="center">
            <button className="btn" type="submit">
              Agregar
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
