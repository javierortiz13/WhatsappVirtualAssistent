import { BUSINESS_TYPE_LABELS, type TenantPhone, tenantPhones } from "@caja/core";
import { eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { COUNTRY_CODES, formatE164 } from "@/lib/phone";
import { requireTenant } from "@/lib/session";
import { addEmployeeAction, setPhoneStatusAction } from "./actions";

export const metadata: Metadata = { title: "Ajustes" };
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

export default async function Ajustes({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { user, tenant } = await requireTenant();
  const sp = await searchParams;
  const { phones, businessType } = await withTenant(db(), tenant.id, async (tx) => {
    const [row] = await tx
      .select({ businessType: schema.tenant.businessType })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenant.id));
    return { phones: await tenantPhones(tx, tenant.id), businessType: row?.businessType ?? "" };
  });
  const owner = phones.find((p) => p.role === "owner");
  const isOwner = tenant.role === "owner";
  return (
    <div className="stack">
      <div className="card stack">
        <div>
          <p className="kpi-label">Negocio</p>
          <p style={{ margin: 0, fontWeight: 600 }}>{tenant.name}</p>
          <p className="kpi-sub">
            {BUSINESS_TYPE_LABELS[businessType as keyof typeof BUSINESS_TYPE_LABELS] ??
              businessType}{" "}
            · estado: {tenant.status === "trial" ? "en prueba" : tenant.status}
          </p>
        </div>
        <div>
          <p className="kpi-label">Cuenta</p>
          <p style={{ margin: 0 }}>{user.email}</p>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Números de WhatsApp</h2>
        {sp.error ? <div className="notice err">{ERRORS[sp.error] ?? sp.error}</div> : null}
        {sp.ok === "alta" ? (
          <div className="notice ok">
            Listo. Cuando ese número le escriba al asistente por primera vez, recibe la bienvenida y
            ya puede registrar gastos y ventas.
          </div>
        ) : null}
        {owner?.status === "pending" ? (
          <div className="notice err">
            Tu número todavía no está vinculado. <a href="/registro">Vincúlalo aquí</a> para poder
            escribirle al asistente.
          </div>
        ) : null}
        <ul className="list">
          {phones.map((p) => (
            <li key={p.id}>
              <span className="title">
                {p.displayName ?? (p.role === "owner" ? "Dueño" : "Empleado")}{" "}
                <span className={`badge ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
              </span>
              <span className="amt" style={{ fontWeight: 400, fontSize: 14 }}>
                {formatE164(p.e164)}
              </span>
              <span className="meta">{p.role === "owner" ? "dueño" : "empleado"}</span>
              {isOwner && p.role === "employee" ? (
                <form action={setPhoneStatusAction} className="amt2">
                  <input type="hidden" name="phone_id" value={p.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={p.status === "disabled" ? "active" : "disabled"}
                  />
                  <button className="btn secondary small" type="submit">
                    {p.status === "disabled" ? "Reactivar" : "Desactivar"}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <form action={addEmployeeAction} className="stack">
            <p className="kpi-label" style={{ margin: 0 }}>
              Agregar un empleado
            </p>
            <div className="phone-row">
              <select className="input" name="country" defaultValue="58" aria-label="País">
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                name="phone"
                required
                inputMode="tel"
                placeholder="412 1234567"
                aria-label="Número"
              />
            </div>
            <input className="input" name="name" maxLength={60} placeholder="Nombre (opcional)" />
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              El empleado registra gastos y ventas; los cierres los ves solo tú. No necesita código:
              con escribirle al asistente queda activo.
            </p>
            <button className="btn secondary" type="submit">
              Agregar
            </button>
          </form>
        ) : null}
      </div>

      <div className="card">
        <p className="kpi-label">Categorías y exportación</p>
        <p style={{ margin: 0 }} className="muted">
          Llegan en los próximos sprints.
        </p>
      </div>
      <form action="/auth/logout" method="post">
        <button className="btn secondary" type="submit">
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
