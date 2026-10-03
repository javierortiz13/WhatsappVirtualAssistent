import type { Metadata } from "next";

export const metadata: Metadata = { title: "No encontrado" };

/** 404 en español para toda la web (antes salía la página por defecto de Next, en inglés). */
export default function NotFound() {
  return (
    <main className="login">
      <div className="card stack center-text">
        <h1 style={{ fontSize: 22, margin: 0 }}>No encontramos esa página</h1>
        <p className="sub">
          Puede que el enlace esté mal escrito o que lo que buscabas ya no exista.
        </p>
        <div className="center">
          <a className="btn" href="/inicio">
            Ir a Inicio
          </a>
        </div>
      </div>
    </main>
  );
}
