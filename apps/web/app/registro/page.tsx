import { BUSINESS_TYPE_LABELS, CODE_TTL_MS, ownerPhone } from "@caja/core";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { COUNTRY_CODES, formatE164 } from "@/lib/phone";
import { currentSession } from "@/lib/session";
import { newCodeAction, registerBusinessAction } from "./actions";
import { LINK_COOKIE } from "./cookie";
import { LinkStatus } from "./link-status";

export const metadata: Metadata = { title: "Registro" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  datos: "Revisa los datos: falta algo o hay un campo que no se ve bien.",
  telefono: "Ese número no se ve bien. Escríbelo sin el código de país, por ejemplo 412 1234567.",
  ocupado: "Ese número ya pertenece a otro negocio. Un número solo puede estar en un negocio.",
  servidor: "No pudimos crear el negocio. Inténtalo en unos minutos.",
};

/**
 * Onboarding en dos pasos (US-A1, US-A2). Paso 1: el negocio. Paso 2: el código de vinculación
 * que el dueño envía por WhatsApp; la pantalla se actualiza sola cuando llega.
 */
export default async function Registro({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const sp = await searchParams;
  if (!session.tenant) return <Step1 error={(sp.error && ERRORS[sp.error]) ?? null} />;

  const owner = await ownerPhone(db(), session.tenant.id);
  if (owner?.status !== "pending") redirect("/inicio");
  const store = await cookies();
  const raw = store.get(LINK_COOKIE)?.value ?? "";
  const [code, exp] = raw.split(".");
  const expiresAt = Number(exp);
  const valid = /^\d{6}$/.test(code ?? "") && expiresAt > Date.now();
  return (
    <Step2
      tenantName={session.tenant.name}
      phone={owner.e164}
      code={valid ? (code as string) : null}
      expiresAt={valid ? expiresAt : null}
      platformNumber={env().PLATFORM_WA_NUMBER ?? null}
    />
  );
}

function Step1({ error }: { error: string | null }) {
  return (
    <main className="login">
      <div className="card stack">
        <div>
          <p className="steps">● ○ &nbsp; Paso 1 de 2</p>
          <h1 style={{ fontSize: 20, margin: 0 }}>Tu negocio</h1>
        </div>
        <form action={registerBusinessAction} className="stack">
          {error ? <div className="notice err">{error}</div> : null}
          <label className="field">
            <span>Nombre del negocio</span>
            <input
              className="input"
              name="name"
              required
              minLength={2}
              maxLength={80}
              placeholder="Autolavado El Rápido"
              autoComplete="organization"
            />
          </label>
          <label className="field">
            <span>Tipo</span>
            <select className="input" name="business_type" defaultValue="car_wash" required>
              {Object.entries(BUSINESS_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="field choices">
            <legend>Moneda en la que sueles hablar de gastos</legend>
            <label>
              <input type="radio" name="currency" value="USD" defaultChecked /> Dólares
            </label>
            <label>
              <input type="radio" name="currency" value="VES" /> Bolívares
            </label>
          </fieldset>
          <label className="field">
            <span>Tu WhatsApp (el del dueño)</span>
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
                autoComplete="tel-national"
                placeholder="412 1234567"
              />
            </div>
          </label>
          <label className="field">
            <span>Tu nombre (opcional)</span>
            <input className="input" name="owner_name" maxLength={60} autoComplete="name" />
          </label>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Te crearemos categorías de gasto típicas de tu tipo de negocio. Luego las puedes
            cambiar.
          </p>
          <button className="btn" type="submit">
            Continuar
          </button>
        </form>
      </div>
    </main>
  );
}

function Step2(props: {
  tenantName: string;
  phone: string;
  code: string | null;
  expiresAt: number | null;
  platformNumber: string | null;
}) {
  const waHref =
    props.code && props.platformNumber
      ? `https://wa.me/${props.platformNumber}?text=${encodeURIComponent(props.code)}`
      : null;
  return (
    <main className="login">
      <div className="card stack">
        <div>
          <p className="steps">○ ● &nbsp; Paso 2 de 2</p>
          <h1 style={{ fontSize: 20, margin: 0 }}>Tu WhatsApp</h1>
        </div>
        <p style={{ margin: 0 }}>
          <span className="muted">Negocio:</span> <strong>{props.tenantName}</strong>
          <br />
          <span className="muted">Número del dueño:</span>{" "}
          <strong>{formatE164(props.phone)}</strong>
        </p>
        {props.code && props.expiresAt ? (
          <>
            <div>
              <p className="kpi-label">Tu código de vinculación</p>
              <p className="code">{props.code}</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                Envíalo desde ese número al asistente. Solo sirve por{" "}
                {Math.round(CODE_TTL_MS / 60000)} minutos.
              </p>
            </div>
            {waHref ? (
              <a className="btn" href={waHref} target="_blank" rel="noreferrer">
                Abrir WhatsApp ↗
              </a>
            ) : (
              <p className="notice" style={{ margin: 0, fontSize: 14 }}>
                Abre WhatsApp y envía el código al número del asistente.
              </p>
            )}
            <LinkStatus expiresAt={props.expiresAt} />
          </>
        ) : (
          <p className="notice" style={{ margin: 0 }}>
            Tu número todavía no está vinculado. Genera un código y envíalo por WhatsApp.
          </p>
        )}
        <form action={newCodeAction}>
          <button className="btn secondary" type="submit">
            {props.code ? "Generar otro código" : "Generar código"}
          </button>
        </form>
      </div>
    </main>
  );
}
