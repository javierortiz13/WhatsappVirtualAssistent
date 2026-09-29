import { redirect } from "next/navigation";
import { currentSession } from "@/lib/session";

export default async function SinNegocio() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.tenant) redirect("/inicio");
  return (
    <main className="login">
      <div className="card stack">
        <h1 style={{ fontSize: 20, margin: 0 }}>Todavía no tienes un negocio aquí</h1>
        <p className="muted" style={{ margin: 0 }}>
          Entraste como <strong>{session.user.email}</strong>, pero ese correo no está asociado a
          ningún negocio. El registro de negocios llega pronto; por ahora pide acceso al soporte.
        </p>
        <form action="/auth/logout" method="post">
          <button className="btn secondary" type="submit">
            Salir
          </button>
        </form>
      </div>
    </main>
  );
}
