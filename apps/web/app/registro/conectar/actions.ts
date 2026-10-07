"use server";

import { createDashboardLink } from "@caja/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { currentSession } from "@/lib/session";
import { CONNECT_COOKIE } from "./cookie";

/**
 * Registro por WhatsApp (0018): el usuario del panel pide un código y se lo manda a Rocco desde
 * su número. Así prueba que el número es suyo y su correo queda como dueño del negocio.
 */
export async function newConnectCodeAction(): Promise<void> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.tenant) redirect("/inicio");
  const issued = await createDashboardLink(db(), session.user.id);
  const store = await cookies();
  store.set(CONNECT_COOKIE, `${issued.code}.${issued.expiresAt.getTime()}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/registro/conectar",
    expires: issued.expiresAt,
  });
  redirect("/registro/conectar");
}
