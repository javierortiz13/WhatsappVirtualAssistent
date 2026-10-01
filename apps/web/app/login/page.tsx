import type { Metadata } from "next";
import { sendMagicLink } from "./actions";

export const metadata: Metadata = { title: "Entrar" };

const ERRORS: Record<string, string> = {
  correo: "Ese correo no se ve bien. Revísalo e inténtalo de nuevo.",
  espera: "Ya te enviamos un enlace hace poco. Espera un minuto antes de pedir otro.",
  envio: "No pudimos enviar el correo. Inténtalo en unos minutos.",
  enlace: "Ese enlace ya no sirve. Pide uno nuevo.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;
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
                <strong>Escribe tu correo.</strong> Te mandamos un enlace y entras con un toque.
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
            <form action={sendMagicLink} className="stack">
              {error ? <div className="notice err">{error}</div> : null}
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
