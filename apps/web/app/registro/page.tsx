import {
  BUSINESS_TYPE_LABELS,
  CODE_TTL_MS,
  ONBOARDING_MAX_ACCOUNTS,
  ownerPhone,
  PLANS,
} from "@caja/core";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  MAX_ACTIVE_CATEGORIES,
  SUGGESTED_EXPENSE_CATEGORIES,
} from "@caja/db/seed-data";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { formatE164 } from "@/lib/phone";
import { currentSession } from "@/lib/session";
import { newCodeAction } from "./actions";
import { LINK_COOKIE } from "./cookie";
import { LinkStatus } from "./link-status";
import { RegistroWizard } from "./wizard";

export const metadata: Metadata = { title: "Registro" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  datos: "Revisa los datos: falta algo o hay un campo que no se ve bien.",
  telefono: "Ese número no se ve bien. Escríbelo sin el código de país, por ejemplo 412 1234567.",
  ocupado: "Ese número ya pertenece a otro negocio. Un número solo puede estar en un negocio.",
  servidor: "No pudimos crear el negocio. Inténtalo en unos minutos.",
};

/**
 * Onboarding (US-A1, US-A2; paso a paso desde el 05/10/2026). Sin cuenta: el asistente de pasos
 * (plan, perfil, categorías, cuentas, WhatsApp). Con la cuenta creada: el código de vinculación
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
  if (!session.tenant)
    return (
      <>
        {sp.error && ERRORS[sp.error] ? (
          <div className="notice err wizard-flash">{ERRORS[sp.error]}</div>
        ) : null}
        <div className="notice wizard-flash">
          ¿Ya creaste tu cuenta chateando con Rocco por WhatsApp?{" "}
          <a href="/registro/conectar">
            <strong>Ya me registré con Rocco ›</strong>
          </a>
        </div>
        <RegistroWizard
          plans={PLANS.map((p) => ({
            id: p.id,
            name: p.name,
            priceUsd: p.priceUsd,
            tagline: p.tagline,
            features: p.features,
          }))}
          businessTypes={Object.entries(BUSINESS_TYPE_LABELS)
            .filter(([k]) => k !== "personal")
            .map(([id, label]) => ({ id, label }))}
          defaults={DEFAULT_EXPENSE_CATEGORIES}
          suggestions={SUGGESTED_EXPENSE_CATEGORIES}
          maxCategories={MAX_ACTIVE_CATEGORIES}
          maxAccounts={ONBOARDING_MAX_ACCOUNTS}
          pilotNote="Durante la beta no se cobra: empiezas con 14 días de prueba y te avisamos antes de cobrar."
        />
      </>
    );

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
    <main className="wizard">
      <header className="wizard-top">
        <span className="iconbtn" aria-hidden="true">
          ✓
        </span>
        <ol className="progress" aria-label="Paso 6 de 6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="progress-seg done" />
          ))}
        </ol>
      </header>
      <section className="wizard-body">
        <h1>Último paso: tu código</h1>
        <p className="lead">
          Envía este código por WhatsApp desde <strong>{formatE164(props.phone)}</strong> y{" "}
          <strong>{props.tenantName}</strong> queda lista.
        </p>
        {props.code && props.expiresAt ? (
          <div className="panel stack">
            <p className="code">{props.code}</p>
            {waHref ? (
              <a className="btn block wa" href={waHref} target="_blank" rel="noreferrer">
                💬 Enviar el código por WhatsApp
              </a>
            ) : (
              <p className="notice" style={{ margin: 0, fontSize: 14 }}>
                Abre WhatsApp y envía el código al número de Rocco.
              </p>
            )}
            <ol className="howto">
              <li>
                Toca el botón: se abre WhatsApp con el código <strong>ya escrito</strong>.
              </li>
              <li>Dale enviar. Sirve por {Math.round(CODE_TTL_MS / 60000)} minutos.</li>
              <li>Esta pantalla cambia sola cuando llegue.</li>
            </ol>
            <LinkStatus expiresAt={props.expiresAt} />
          </div>
        ) : (
          <p className="notice" style={{ margin: 0 }}>
            Tu número todavía no está vinculado. Genera un código y envíalo por WhatsApp.
          </p>
        )}
        <form action={newCodeAction} className="center">
          <button className="btn secondary small" type="submit">
            {props.code ? "Generar otro código" : "Generar código"}
          </button>
        </form>
      </section>
    </main>
  );
}
