import { LINK_TTL_MS } from "@caja/core";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { currentSession } from "@/lib/session";
import { newConnectCodeAction } from "./actions";
import { ConnectStatus } from "./connect-status";
import { CONNECT_COOKIE } from "./cookie";

export const metadata: Metadata = { title: "Conectar con Rocco" };
export const dynamic = "force-dynamic";

/**
 * Quien creó su cuenta en el chat con Rocco (0018) entra al panel con su correo y conecta su
 * negocio mandándole a Rocco, desde su número, el código de esta pantalla.
 */
export default async function Conectar() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.tenant) redirect("/inicio");
  const store = await cookies();
  const [code, exp] = (store.get(CONNECT_COOKIE)?.value ?? "").split(".");
  const expiresAt = Number(exp);
  const valid = /^\d{6}$/.test(code ?? "") && expiresAt > Date.now();
  const platform = env().PLATFORM_WA_NUMBER ?? null;
  const waHref =
    valid && platform ? `https://wa.me/${platform}?text=${encodeURIComponent(code ?? "")}` : null;
  return (
    <main className="wizard">
      <header className="wizard-top">
        <a className="iconbtn" href="/registro" aria-label="Atrás">
          ‹
        </a>
      </header>
      <section className="wizard-body">
        <h1>Conecta tu cuenta de Rocco</h1>
        <p className="lead">
          Si creaste tu cuenta chateando con Rocco, mándale este código desde tu WhatsApp y tu
          dashboard queda conectado a <strong>{session.user.email}</strong>.
        </p>
        {valid ? (
          <div className="panel stack">
            <p className="code">{code}</p>
            {waHref ? (
              <a className="btn block wa" href={waHref} target="_blank" rel="noreferrer">
                💬 Enviar el código a Rocco
              </a>
            ) : (
              <p className="notice" style={{ margin: 0, fontSize: 14 }}>
                Abre el chat con Rocco y envíale el código.
              </p>
            )}
            <ol className="howto">
              <li>
                Envíalo desde el <strong>mismo número</strong> con el que te registraste.
              </li>
              <li>Sirve por {Math.round(LINK_TTL_MS / 60000)} minutos.</li>
              <li>Esta pantalla cambia sola cuando llegue.</li>
            </ol>
            <ConnectStatus expiresAt={expiresAt} />
          </div>
        ) : null}
        <form action={newConnectCodeAction} className="center">
          <button className={valid ? "btn secondary small" : "btn block"} type="submit">
            {valid ? "Generar otro código" : "Generar mi código"}
          </button>
        </form>
        <p className="muted center" style={{ fontSize: 14 }}>
          ¿Todavía no tienes cuenta? <a href="/registro">Créala aquí</a> o escríbele a Rocco por
          WhatsApp.
        </p>
      </section>
    </main>
  );
}
