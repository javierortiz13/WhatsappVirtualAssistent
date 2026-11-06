import "server-only";
import { HABIT_DEFAULTS, habitSettings } from "@caja/core";
import { db } from "./db";

/**
 * Invitaciones en la web (PRD hábitos v4.2.1, P4-B, US-420). La cookie `rocco_ref` guarda solo el
 * código, 30 días (SEC-P4-6); con `referrals` apagado no se pone ni se lee. Ningún camino de aquí
 * dice si un código existe (SEC-P4-2): eso solo se sabe en `/registro` (RW6i) y en el chat.
 */
export const REF_COOKIE = "rocco_ref";
export const REF_COOKIE_DAYS = 30;

export const refCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: REF_COOKIE_DAYS * 86_400,
};

/** ¿Están encendidos `xp` y `referrals`? Sin base (build), no. */
export async function referralsOn(): Promise<boolean> {
  try {
    const f = await habitSettings(db());
    return f.xp && f.referrals;
  } catch {
    return HABIT_DEFAULTS.referrals;
  }
}

export { cleanCode, safeNext, waLink } from "./referral-url";
