import "server-only";
import { HABIT_DEFAULTS, habitSettings } from "@caja/core";
import { db } from "./db";

/**
 * Invitaciones en la web (PRD hábitos v4.2.1, P4-B, US-420). La cookie `rocco_ref` guarda solo el
 * código, 30 días (SEC-P4-6); con `referrals` apagado no se pone ni se lee. Ningún camino de aquí
 * dice si un código existe (SEC-P4-2): eso solo se sabe en el chat (desde W-1, `/registro` ya no
 * muestra RW6i).
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

/** Cuánto vale la respuesta de `referralsOn()` en esta instancia (seguridad F6). */
export const REFERRALS_ON_TTL_MS = 30_000;
let memo: { at: number; on: boolean } | null = null;

/**
 * ¿Están encendidos `xp` y `referrals`? Sin base (build), no. Se guarda 30 s en memoria (seguridad
 * F6): `/w`, `/w/CODE`, `/api/ref` y `?ref=` no leen la base en cada visita. Un cambio desde
 * /admin llega a cada instancia en 30 s como mucho (en la del administrador, al instante). Un
 * error no se guarda: la próxima visita vuelve a mirar.
 */
export async function referralsOn(): Promise<boolean> {
  const now = Date.now();
  if (memo && now - memo.at < REFERRALS_ON_TTL_MS) return memo.on;
  try {
    const f = await habitSettings(db());
    memo = { at: now, on: f.xp && f.referrals };
    return memo.on;
  } catch {
    return HABIT_DEFAULTS.referrals;
  }
}

/** Olvida lo guardado (al guardar los interruptores desde /admin, y en las pruebas). */
export function forgetReferralsOn(): void {
  memo = null;
}

export { cleanCode, safeNext, waLink } from "./referral-url";
