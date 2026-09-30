"use server";

import {
  BUSINESS_TYPE_LABELS,
  issueCode,
  ownerPhone,
  PhoneTakenError,
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

const Form = z.object({
  name: z.string().trim().min(2).max(80),
  business_type: z.enum(Object.keys(BUSINESS_TYPE_LABELS) as [string, ...string[]]),
  currency: z.enum(["USD", "VES"]),
  country: z.string().min(1).max(4),
  phone: z.string().min(6).max(24),
  owner_name: z.string().trim().max(60).optional(),
});

export async function registerBusinessAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.tenant) redirect("/registro");
  const parsed = Form.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/registro?error=datos");
  const e164 = toE164(parsed.data.country, parsed.data.phone);
  if (!e164) redirect("/registro?error=telefono");
  try {
    const r = await registerBusiness(db(), {
      userId: session.user.id,
      name: parsed.data.name,
      businessType: parsed.data.business_type as keyof typeof BUSINESS_TYPE_LABELS,
      defaultExpenseCurrency: parsed.data.currency,
      ownerPhone: e164,
      ownerName: parsed.data.owner_name || null,
    });
    await setLinkCookie(r.code, r.expiresAt);
  } catch (err) {
    if (err instanceof PhoneTakenError) redirect("/registro?error=ocupado");
    console.error(JSON.stringify({ level: "error", msg: "registro", detail: String(err) }));
    redirect("/registro?error=servidor");
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
