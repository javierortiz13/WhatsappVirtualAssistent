import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "../env";

/**
 * Cliente de Supabase Auth para componentes de servidor, acciones y route handlers. Solo se usa
 * para la sesión (magic link, cookies): los datos del negocio se leen con Drizzle y RLS.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env().NEXT_PUBLIC_SUPABASE_URL, env().NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // En un componente de servidor no se pueden escribir cookies; el proxy las refresca.
        }
      },
    },
  });
}
