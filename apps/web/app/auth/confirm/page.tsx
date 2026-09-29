import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Entrar" };
export const dynamic = "force-dynamic";

/**
 * Destino del magic link. No valida al abrir: los clientes de correo visitan los enlaces para
 * previsualizarlos y gastarían el token de un solo uso. Muestra un botón y valida con un POST.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; code?: string }>;
}) {
  const sp = await searchParams;
  if (!sp.token_hash && !sp.code) redirect("/login?error=enlace");
  return (
    <main className="login">
      <div className="card stack">
        <h1 style={{ fontSize: 20, margin: 0 }}>Un toque más</h1>
        <p className="muted" style={{ margin: 0 }}>
          Confirma que eres tú para entrar a Asistente de Caja.
        </p>
        <form action="/auth/confirm/verify" method="post" id="verify">
          {sp.token_hash ? <input type="hidden" name="token_hash" value={sp.token_hash} /> : null}
          {sp.type ? <input type="hidden" name="type" value={sp.type} /> : null}
          {sp.code ? <input type="hidden" name="code" value={sp.code} /> : null}
          <button className="btn" type="submit">
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}
