import type { Metadata } from "next";
import { env } from "@/lib/env";
import { sendMagicLink, signInWithGoogle } from "./actions";

export const metadata: Metadata = { title: "Entrar" };

const ERRORS: Record<string, string> = {
  correo: "Ese correo no se ve bien. Revísalo e inténtalo de nuevo.",
  espera: "Ya te enviamos un enlace hace poco. Espera un minuto antes de pedir otro.",
  envio: "No pudimos enviar el correo. Inténtalo en unos minutos.",
  enlace: "Ese enlace ya no sirve. Pide uno nuevo.",
  google: "No pudimos entrar con Google. Inténtalo de nuevo o usa tu correo.",
  google_cancelado: "No se completó la entrada con Google. Puedes intentarlo otra vez.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string; error?: string; eliminada?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;
  const google = env().GOOGLE_AUTH_ENABLED;
  return (
    <main className="auth">
      <section className="auth-intro">
        <div className="brand">
          <BrandMark />
          <div>
            <strong className="brand-name">Asistente de Caja</strong>
            <p>Tu asistente administrativo por WhatsApp</p>
          </div>
        </div>
        <h1>
          Tu caja, en un chat de <span className="hl">WhatsApp</span>.
        </h1>
        <p className="auth-lead">
          Escríbele o mándale un audio: anota gastos y ventas, convierte a la tasa BCV y te da el
          cierre del día. Sin apps nuevas.
        </p>
      </section>

      <section className="auth-demo">
        <ChatMock />
        <ul className="auth-chips">
          <li className="auth-chip">🎙️ Notas de voz</li>
          <li className="auth-chip">🧾 Fotos de facturas</li>
          <li className="auth-chip">💱 Tasa BCV y euro</li>
          <li className="auth-chip">💳 Banco, Binance y efectivo</li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="card auth-card">
          {sp.enviado ? (
            <div className="stack">
              <div className="mail-icon" aria-hidden="true">
                ✉️
              </div>
              <h2>Revisa tu correo</h2>
              <p className="sub" style={{ margin: 0 }}>
                Te enviamos un enlace para entrar. Sirve por 15 minutos y solo una vez. Si no llega
                en un minuto, mira en spam.
              </p>
              <a className="btn secondary block" href="/login">
                Pedir otro enlace
              </a>
            </div>
          ) : (
            <>
              <div>
                <h2>Entra o crea tu cuenta</h2>
                <p className="sub" style={{ margin: "6px 0 0" }}>
                  En 3 minutos, sin contraseñas ni tarjeta.
                </p>
              </div>
              {error ? <div className="notice err">{error}</div> : null}
              {sp.eliminada ? (
                <div className="notice ok">
                  Tu cuenta quedó en la papelera y se borra para siempre en 15 días. Si fue un
                  error, entra con tu correo y recupérala.
                </div>
              ) : null}
              {google ? (
                <>
                  <form action={signInWithGoogle}>
                    <button className="btn block google" type="submit">
                      <GoogleLogo />
                      Continuar con Google
                    </button>
                  </form>
                  <p className="divider" aria-hidden="true">
                    o con tu correo
                  </p>
                </>
              ) : null}
              <form action={sendMagicLink} className="auth-form">
                <label className="field">
                  <span>Tu correo</span>
                  <input
                    className="input"
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    inputMode="email"
                    placeholder="tucorreo@gmail.com"
                  />
                </label>
                <button className="btn block" type="submit">
                  Enviarme el enlace
                </button>
              </form>
              <ol className="mini-steps">
                <li className="mini-step">
                  <span className="mini-num">1</span>Entra
                </li>
                <li className="mini-step">
                  <span className="mini-num">2</span>Elige tu plan
                </li>
                <li className="mini-step">
                  <span className="mini-num">3</span>Vincula tu WhatsApp
                </li>
              </ol>
              <p className="pilot">🎁 Gratis durante el piloto · 14 días de prueba</p>
            </>
          )}
        </div>
        <p className="sub center-text auth-foot">
          🔒 Tus datos están aislados y son tuyos · <a href="/">Ver cómo funciona</a>
        </p>
      </section>
    </main>
  );
}

/** Logo de la app (caja registradora en verde). */
function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#0f7b5f" />
      <path d="M16 22h32v22a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4z" fill="#fff" />
      <path d="M14 20a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v4H14z" fill="#d9f2e8" />
      <circle cx="40" cy="35" r="4" fill="#0f7b5f" />
    </svg>
  );
}

/** Conversación de ejemplo: lo que pasa de verdad cuando le escribes al asistente. */
function ChatMock() {
  return (
    <figure className="chat-mock" aria-label="Ejemplo de conversación con el asistente">
      <div className="chat-head">
        <span className="chat-avatar">🧾</span>
        <div>
          <strong className="chat-title">Asistente de Caja</strong>
          <small className="chat-sub">en línea</small>
        </div>
      </div>
      <div className="chat-body">
        <p className="bubble me">gasté 15$ en champú</p>
        <div className="bubble bot">
          <strong>Gasto por confirmar</strong>
          <span>
            Champú: <b>$15,00</b>
          </span>
          <span className="muted">Bs 12.870 · tasa BCV 858,00</span>
          <span className="muted">Categoría: Insumos de lavado</span>
          <div className="bubble-btns">
            <span className="bubble-btn">Guardar</span>
            <span className="bubble-btn">Corregir</span>
          </div>
        </div>
        <p className="bubble me">cómo va el mes?</p>
        <div className="bubble bot">
          <strong>📊 Octubre</strong>
          <span>
            Ventas <b className="mint">$1.240</b> · Gastos <b className="amber">$380</b>
          </span>
          <span>
            Neto <b>$860</b>
          </span>
        </div>
      </div>
    </figure>
  );
}

/** Logo "G" de Google en sus colores oficiales, como piden sus pautas del botón. */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
