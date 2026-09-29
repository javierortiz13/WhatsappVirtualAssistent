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
      <div className="card">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#0f7b5f" />
            <path d="M16 22h32v22a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4z" fill="#fff" />
            <path d="M14 20a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v4H14z" fill="#d9f2e8" />
            <circle cx="40" cy="35" r="4" fill="#0f7b5f" />
          </svg>
          <div>
            <h1>Asistente de Caja</h1>
            <p>Tu caja, por WhatsApp.</p>
          </div>
        </div>
        {sp.enviado ? (
          <div className="notice ok stack">
            <p style={{ margin: 0 }}>
              <strong>Revisa tu correo.</strong> Te enviamos un enlace para entrar. Sirve por 15
              minutos y solo una vez.
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Si no llega, mira en spam o pide otro.
            </p>
            <a className="btn secondary" href="/login">
              Pedir otro enlace
            </a>
          </div>
        ) : (
          <form action={sendMagicLink} className="stack">
            {error ? <div className="notice err">{error}</div> : null}
            <label className="field">
              <span>Tu correo</span>
              <input
                className="input"
                type="email"
                name="email"
                required
                autoComplete="email"
                inputMode="email"
                placeholder="dueno@minegocio.com"
              />
            </label>
            <button className="btn" type="submit">
              Enviarme el enlace
            </button>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              Sin contraseñas. Te llega un enlace y entras con un toque.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
