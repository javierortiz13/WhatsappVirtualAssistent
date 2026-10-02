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
  searchParams: Promise<{ enviado?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;
  const google = env().GOOGLE_AUTH_ENABLED;
  return (
    <main className="login">
      <div className="card stack">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#0f7b5f" />
            <path d="M16 22h32v22a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4z" fill="#fff" />
            <path d="M14 20a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v4H14z" fill="#d9f2e8" />
            <circle cx="40" cy="35" r="4" fill="#0f7b5f" />
          </svg>
          <div>
            <h1>Asistente de Caja</h1>
            <p>Tu asistente administrativo por WhatsApp.</p>
          </div>
        </div>
        {sp.enviado ? (
          <div className="notice ok stack">
            <p style={{ margin: 0 }}>
              <strong>Revisa tu correo.</strong> Te enviamos un enlace para entrar. Sirve por 15
              minutos y solo una vez.
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Si no llega en un minuto, mira en spam o pide otro.
            </p>
            <div className="center">
              <a className="btn secondary" href="/login">
                Pedir otro enlace
              </a>
            </div>
          </div>
        ) : (
          <>
            <div>
              <h2 style={{ fontSize: 22, marginBottom: 6 }}>Entra o crea tu cuenta en 3 minutos</h2>
              <p className="sub">Sin contraseñas ni tarjeta. Durante el piloto no se cobra.</p>
            </div>
            <ol className="howto">
              <li>
                {google ? (
                  <>
                    <strong>Entra con Google o con tu correo.</strong> Con el correo te mandamos un
                    enlace y entras con un toque.
                  </>
                ) : (
                  <>
                    <strong>Escribe tu correo.</strong> Te mandamos un enlace y entras con un toque.
                  </>
                )}
              </li>
              <li>
                <strong>Registra tu negocio</strong> y el número de WhatsApp desde el que vas a
                escribirle.
              </li>
              <li>
                <strong>Envía el código de 6 dígitos</strong> al asistente. Desde ese momento anota
                lo que le digas.
              </li>
            </ol>
            {error ? <div className="notice err">{error}</div> : null}
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
            <form action={sendMagicLink} className="stack">
              <label className="field">
                <span>Tu correo</span>
                <input
                  className="input center"
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  placeholder="dueno@minegocio.com"
                />
              </label>
              <button className="btn block" type="submit">
                Enviarme el enlace
              </button>
              <p className="sub center-text">
                Tus datos son tuyos: cada negocio está aislado y puedes borrar tu cuenta cuando
                quieras.
              </p>
            </form>
          </>
        )}
        <p className="sub center-text">
          <a href="/">← Ver cómo funciona</a>
        </p>
      </div>
    </main>
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
