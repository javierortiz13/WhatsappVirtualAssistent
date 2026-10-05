"use server";

import {
  AccountError,
  BUSINESS_TYPE_LABELS,
  Decimal,
  issueCode,
  ownerPhone,
  PhoneTakenError,
  parseVenezuelanAmount,
  registerBusiness,
} from "@caja/core";
import { withTenant } from "@caja/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { toE164 } from "@/lib/phone";
import { currentSession } from "@/lib/session";
import { LINK_COOKIE } from "./cookie";

export type WizardState = { error: string | null; step?: number };

const Account = z.object({
  name: z.string().trim().min(1).max(40),
  currency: z.enum(["USD", "VES"]),
  kind: z.enum(["bank", "cash", "zelle", "crypto", "other"]),
  opening: z.string().max(30).optional(),
});

const WizardForm = z.object({
  plan: z.enum(["personal", "negocio", "negocio_plus"]),
  name: z.string().trim().min(2).max(80),
  business_type: z.enum(Object.keys(BUSINESS_TYPE_LABELS) as [string, ...string[]]),
  currency: z.enum(["USD", "VES"]),
  categories: z.array(z.string().trim().min(1).max(40)).max(20),
  accounts: z.array(Account).max(3),
  country: z.string().min(1).max(4),
  phone: z.string().min(6).max(24),
  owner_name: z.string().trim().max(60).optional(),
});

/** Saldo como lo escribe una persona en Venezuela ("12.500,50"); vacío o ilegible es cero. */
function opening(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "0";
  const d = parseVenezuelanAmount(t) ?? (/^\d+(\.\d+)?$/.test(t) ? new Decimal(t) : null);
  return d?.isFinite() && d.gte(0) ? d.toFixed(2) : "0";
}

/**
 * Onboarding paso a paso (05/10): el asistente del navegador junta plan, perfil, categorías,
 * cuentas y número, y los manda juntos en `payload` (JSON). Los errores vuelven al paso que toca
 * sin perder lo escrito.
 */
export async function registerWizardAction(
  _prev: WizardState,
  formData: FormData,
): Promise<WizardState> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.tenant) redirect("/registro");
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return { error: "Faltan datos. Revisa los pasos anteriores.", step: 1 };
  }
  const parsed = WizardForm.safeParse(raw);
  if (!parsed.success) return { error: "Faltan datos. Revisa los pasos anteriores.", step: 1 };
  const f = parsed.data;
  const e164 = toE164(f.country, f.phone);
  if (!e164)
    return {
      error: "Ese número no se ve bien. Escríbelo sin el código de país, por ejemplo 412 1234567.",
    };
  try {
    const r = await registerBusiness(db(), {
      userId: session.user.id,
      name: f.name,
      businessType: f.business_type as keyof typeof BUSINESS_TYPE_LABELS,
      defaultExpenseCurrency: f.currency,
      ownerPhone: e164,
      ownerName: f.owner_name || null,
      plan: f.plan,
      categories: f.categories,
      accounts: f.accounts.map((a) => ({
        name: a.name,
        currency: a.currency,
        kind: a.kind,
        openingBalance: opening(a.opening),
      })),
    });
    await setLinkCookie(r.code, r.expiresAt);
  } catch (err) {
    if (err instanceof PhoneTakenError)
      return {
        error: "Ese número ya pertenece a otra cuenta. Un número solo puede estar en una.",
      };
    if (err instanceof AccountError)
      return {
        error: "Dos de tus cuentas tienen el mismo nombre. Cámbiale el nombre a una.",
        step: 3,
      };
    console.error(JSON.stringify({ level: "error", msg: "registro", detail: String(err) }));
    return { error: "No pudimos crear tu cuenta. Inténtalo en unos minutos." };
  }
  redirect("/registro");
}

/** "Generar otro código": vence el anterior y deja el nuevo en la cookie. */
export async function newCodeAction(): Promise<void> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!session.tenant) redirect("/registro");
  const tenantId = session.tenant.id;
  const owner = await ownerPhone(db(), tenantId);
  if (owner?.status !== "pending") redirect("/inicio");
  const issued = await withTenant(db(), tenantId, (tx) =>
    issueCode(tx, { tenantId, phoneId: owner.id }),
  );
  await setLinkCookie(issued.code, issued.expiresAt);
  redirect("/registro");
}

async function setLinkCookie(code: string, expiresAt: Date) {
  const store = await cookies();
  store.set(LINK_COOKIE, `${code}.${expiresAt.getTime()}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/registro",
    expires: expiresAt,
  });
}
