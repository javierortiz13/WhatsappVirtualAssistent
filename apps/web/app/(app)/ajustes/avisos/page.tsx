import { es, habitSettings, ownerPhone, prefState } from "@caja/core";
import { withTenant } from "@caja/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminEmails } from "@/lib/admin";
import { PRIVACY_CONTACT } from "@/lib/contact";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { IconChevronLeft } from "../../icons";
import { PrefSwitch } from "./pref-switch";

export const metadata: Metadata = { title: "Avisos" };
export const dynamic = "force-dynamic";

const S = es.PREFS_SWITCHES;

const MSG: Record<string, string> = {
  nudge_on: S.nudge.toastOn,
  nudge_off: S.nudge.toastOff,
  unsolicited_on: S.unsolicited.toastOn,
  unsolicited_off: S.unsolicited.toastOff,
  permiso: "Solo el dueño puede cambiar los avisos.",
  tagged: S.taggedHelp(PRIVACY_CONTACT),
  needs_unsolicited: S.nudge.disabledHelp,
  sin_telefono: "Primero vincula tu WhatsApp.",
  invalid: "No se pudo guardar. Inténtalo de nuevo.",
};

/**
 * Avisos de Rocco (PRD hábitos US-205, H14): los mismos apagados y encendidos del chat. Solo con
 * `habits.prefs` encendido (o un administrador, para revisarla) y solo el dueño. El aviso de racha se muestra cuando existe
 * (`habits.nudge`): su ayuda describe el aviso de las 8 pm.
 */
export default async function Avisos({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { tenant, user } = await requireTenant();
  const flags = await habitSettings(db());
  // Con el interruptor apagado, solo los administradores la ven (para revisarla antes de encender).
  const admin = adminEmails().includes(user.email.toLowerCase());
  if ((!flags.prefs && !admin) || tenant.role !== "owner") notFound();
  const sp = await searchParams;
  const notice = sp.ok ? MSG[sp.ok] : sp.error ? MSG[sp.error] : null;
  const phone = await ownerPhone(db(), tenant.id);
  const s = phone
    ? await withTenant(db(), tenant.id, (tx) => prefState(tx, phone.id, tenant.id))
    : null;
  const tagged = Boolean(s?.tagged);
  const unsolicitedOn = Boolean(s) && !s?.unsolicitedOffAt && !tagged;
  const paused = s?.nudgePausedUntil ? s.nudgePausedUntil.getTime() > Date.now() : false;
  const nudgeOn = Boolean(s?.nudgeOptInAt) && !s?.nudgeOffAt && !paused && unsolicitedOn;
  const taggedHelp = S.taggedHelp(PRIVACY_CONTACT);
  return (
    <div className="stack">
      <div className="rate">
        <a className="iconbtn" href="/ajustes" aria-label="Volver a ajustes">
          <IconChevronLeft />
        </a>
        <span className="sub">Ajustes</span>
      </div>
      {notice ? (
        <div className={`notice ${sp.error ? "err" : "ok"}`} role="status">
          {notice}
        </div>
      ) : null}
      {!s ? (
        <p className="sub">{MSG.sin_telefono}</p>
      ) : (
        <div className="card stack-sm">
          <PrefSwitch
            which="unsolicited"
            on={unsolicitedOn}
            label={S.unsolicited.label}
            help={tagged ? taggedHelp : S.unsolicited.help}
            disabled={tagged}
            confirmTitle={S.unsolicited.confirmTitle}
            confirmBody={S.unsolicited.confirmBody}
            confirm={S.confirm}
            cancel={S.cancel}
          />
          {flags.nudge ? (
            <PrefSwitch
              which="nudge"
              on={nudgeOn}
              label={S.nudge.label}
              help={tagged ? taggedHelp : unsolicitedOn ? S.nudge.help : S.nudge.disabledHelp}
              disabled={tagged || !unsolicitedOn}
              confirmTitle={S.nudge.confirmTitle}
              confirmBody={S.nudge.confirmBody}
              confirm={S.confirm}
              cancel={S.cancel}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
