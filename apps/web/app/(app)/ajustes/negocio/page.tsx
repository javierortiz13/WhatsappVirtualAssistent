import { BUSINESS_TYPE_LABELS, getTenantSettings } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { IconChevronDown, IconChevronLeft } from "../../icons";
import { eraseMyBusinessAction, updateSettingsAction } from "../actions";

export const metadata: Metadata = { title: "Negocio" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  datos: "Revisa los datos del formulario.",
  permiso: "Solo el dueño puede cambiar los datos del negocio.",
  servidor: "No pudimos guardar el cambio. Inténtalo en unos minutos.",
  confirmar: "Para eliminar tu cuenta, escribe el nombre exactamente como aparece.",
};

/** Nombre, tipo y moneda por defecto de los gastos (US-E7). Solo el dueño edita. */
export default async function Negocio({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { tenant } = await requireTenant();
  const sp = await searchParams;
  const settings = await withTenant(db(), tenant.id, (tx) => getTenantSettings(tx, tenant.id));
  const isOwner = tenant.role === "owner";
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {sp.ok === "negocio" ? <div className="notice ok">Datos del negocio guardados.</div> : null}
      {sp.error ? (
        <div className="notice err">
          {ERRORS[sp.error] ?? "No pudimos guardar el cambio. Inténtalo de nuevo."}
        </div>
      ) : null}
      <form action={updateSettingsAction} className="card stack">
        <label className="field">
          <span>Nombre</span>
          <input
            className="input center"
            name="name"
            defaultValue={settings?.name ?? tenant.name}
            minLength={2}
            maxLength={80}
            required
            disabled={!isOwner}
          />
        </label>
        <label className="field">
          <span>Tipo</span>
          <span className="sel">
            <select
              className="input"
              name="business_type"
              defaultValue={settings?.businessType ?? "other"}
              disabled={!isOwner}
            >
              {Object.entries(BUSINESS_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <IconChevronDown size={16} />
          </span>
        </label>
        <label className="field">
          <span>Moneda en la que sueles hablar de gastos</span>
          <span className="sel">
            <select
              className="input"
              name="currency"
              defaultValue={settings?.defaultExpenseCurrency ?? "USD"}
              disabled={!isOwner}
            >
              <option value="USD">Dólares</option>
              <option value="VES">Bolívares</option>
            </select>
            <IconChevronDown size={16} />
          </span>
          <span className="sub">Cuando dices "gasté 20" sin moneda, Rocco asume esta.</span>
        </label>
        <label className="field">
          <span>Tasa para tus gastos en bolívares</span>
          <span className="sel">
            <select
              className="input"
              name="bs_rate_mode"
              defaultValue={settings?.bsRateMode ?? "bcv"}
              disabled={!isOwner}
            >
              <option value="bcv">Tasa BCV</option>
              <option value="usdt">Mis cambios de USDT</option>
              <option value="ask">Preguntarme cada vez</option>
            </select>
            <IconChevronDown size={16} />
          </span>
          <span className="sub">
            Si cobras en USDT y los cambias a Bs, registra cada cambio en{" "}
            <a className="inline-link" href="/ajustes/cambios">
              Cambios USDT
            </a>{" "}
            o por el chat (<em>cambié 100 usdt a 970</em>): tus gastos en Bs quedan en dólares a la
            tasa a la que cambiaste.
          </span>
        </label>
        {isOwner ? (
          <div className="center">
            <button className="btn" type="submit">
              Guardar
            </button>
          </div>
        ) : (
          <p className="sub center-text">Solo el dueño puede cambiar estos datos.</p>
        )}
      </form>
      {isOwner ? (
        <section className="card stack-sm" id="eliminar">
          <span className="label">Eliminar mi cuenta</span>
          <p className="sub">
            Elimina todo lo de <strong>{tenant.name}</strong>: movimientos, cuentas, fotos,
            mensajes, números y tu acceso al panel. Queda 15 días en la papelera por si te
            equivocaste (entras y la recuperas); después se borra para siempre. Si quieres guardar
            tus datos,{" "}
            <a className="inline-link" href="/ajustes/exportar">
              descarga el Excel
            </a>{" "}
            antes.
          </p>
          <form action={eraseMyBusinessAction} className="stack-sm">
            <label className="field">
              <span>Escribe «{tenant.name}» para confirmar</span>
              <input className="input" name="confirm" autoComplete="off" required />
            </label>
            <button className="btn block danger" type="submit">
              Eliminar mi cuenta
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
