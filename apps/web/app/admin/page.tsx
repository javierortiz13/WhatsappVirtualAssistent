import {
  batchAlreadyRan,
  batchSchedule,
  Decimal,
  es,
  habitSettings,
  launchSettings,
  nextBatchSlot,
  PLANS,
  planSignupBatch,
  premiumOverUsd,
  quote,
  SCHEDULE_REFUSALS,
  signupRescueSettings,
  TRIAL_DAYS,
} from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import {
  type Health,
  loadFunnel,
  loadHabits,
  loadMonthOutbound,
  loadNudgeStats,
  loadPendingPayments,
  loadPoints,
  loadRates,
  loadReferrals,
  loadReminderStats,
  loadTenants,
  requireAdmin,
  surveyTally,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { formatE164 } from "@/lib/phone";
import {
  approvePaymentAction,
  cancelBatchAction,
  markFounderContactedAction,
  rejectPaymentAction,
  saveHabitsAction,
  saveLaunchAction,
  saveSignupRescueAction,
  scheduleBatchAction,
} from "./actions";
import { dueClass, dueText, METHOD_LABEL, planClass, STATE, usd, ves } from "./format";
import { PointsCard } from "./points-card";

/** Semáforo del CRM: cuándo escribió por última vez. */
const HEALTH: Record<Health, { label: string; cls: string }> = {
  green: { label: "al día", cls: "ok" },
  amber: { label: "3+ días sin escribir", cls: "warn" },
  red: { label: "7+ días sin escribir", cls: "late" },
};

const STEP_LABEL: Record<string, string> = {
  name: "nombre",
  kind: "para mí o negocio",
  biz_name: "nombre del negocio",
  biz_type: "tipo de negocio",
  currency: "moneda",
  categories: "categorías",
  accounts: "cuentas",
  accounts_confirm: "confirmar cuentas",
  budget: "presupuesto",
};

const OK: Record<string, string> = {
  pago_aprobado: "Pago aprobado. El negocio quedó activo.",
  pago_rechazado: "Pago rechazado.",
  eliminado: "Negocio borrado para siempre con todos sus datos.",
  papelera: "Negocio en la papelera: se borra solo en 15 días.",
  lanzamiento: "Modo de lanzamiento guardado. Rocco lo usa desde el próximo mensaje.",
  habito: "Interruptores del hábito guardados. Rocco los usa desde el próximo mensaje.",
  rescate: "Interruptores del registro guardados.",
  puntos: "Puntos y regalos guardados. Rocco los usa desde el próximo mensaje.",
  mes_aprobado: "Mes de regalo aprobado.",
  mes_rechazado: "Mes de regalo rechazado. Quien invitó lo verá en su próxima respuesta.",
  lote_programado:
    "Lote programado. «Registro: plantilla (lote)» quedó encendido; el worker lo corre solo a la hora.",
  lote_cancelado: "Lote cancelado. «Registro: plantilla (lote)» quedó apagado.",
  registro: "Listo.",
};

/** dd/mm de Caracas. */
const ddmm = (d: Date) => {
  const [, m, day] = businessDateOf(d).split("-");
  return `${day}/${m}`;
};
/** Hasta la lectura del grupo de control (PRD signup-reminders §7): 40 filas o el 31/12/2026. */
const HOLDOUT_UNTIL = "31/12/2026";

/** Resumen de la plataforma: ingresos, costos del mes, pagos por verificar y negocios. */
export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; motivo?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const now = new Date();
  const [tenants, pending, rates, launch] = await Promise.all([
    loadTenants(now),
    loadPendingPayments(),
    loadRates(),
    launchSettings(db()),
  ]);
  const sum = (f: (t: (typeof tenants)[number]) => Decimal) =>
    tenants.reduce((acc, t) => acc.plus(f(t)), new Decimal(0));
  // Ingresos y conteos son de clientes; los costos de IA y Meta, de todo (las internas también gastan).
  const clients = tenants.filter((t) => !t.internal);
  const internal = tenants.length - clients.length;
  const revenue = clients.reduce((acc, t) => acc.plus(t.revenueUsd), new Decimal(0));
  const ai = sum((t) => t.usage.aiCostUsd);
  const meta = sum((t) => t.metaCostUsd);
  const count = (k: string) => clients.filter((t) => t.state.kind === k).length;
  const overCap = tenants.filter((t) => t.usage.inbound > t.cap);
  const premium = rates ? premiumOverUsd(rates) : null;
  const funnel = await loadFunnel(tenants, now);
  const [habits, habitFlags, reminders, rescueFlags, nudges, offs, reminders14, monthOut] =
    await Promise.all([
      loadHabits(tenants, now),
      habitSettings(db()),
      loadReminderStats(tenants, now),
      signupRescueSettings(db()),
      loadNudgeStats(tenants, now),
      // G1-3: las señales para frenar, a 14 días.
      loadNudgeStats(tenants, now, 14),
      loadReminderStats(tenants, now, 14),
      loadMonthOutbound(tenants, now),
    ]);
  const points = await loadPoints(tenants, now);
  const refs = await loadReferrals(tenants, now);
  const rescue = funnel.rescue;
  // Lote de la plantilla del registro (A-0031): programado, ya corrido o lo que saldría ahora.
  const [lote, loteRan] = await Promise.all([batchSchedule(db()), batchAlreadyRan(db())]);
  const lotePlan =
    !loteRan && lote?.status !== "scheduled" && lote?.status !== "running"
      ? await planSignupBatch(db(), { now, maxAgeDays: 30, parkNumbers: [] }).catch(() => null)
      : null;
  /** «mar 10/11 10:00» de Caracas. */
  const loteWhen = (iso: string) => `${formatShortDate(businessDateOf(new Date(iso)))} 10:00`;
  const survey = surveyTally(tenants);
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
  const steps: [string, number, string][] = [
    ["Registros por WhatsApp", funnel.chatStarted, ""],
    ["Terminaron el registro", funnel.chatCompleted, pct(funnel.chatCompleted, funnel.chatStarted)],
    ["Negocios (chat + web)", funnel.tenants, `${funnel.webSignups} por la web`],
    ["Activados (3+ el 1er día)", funnel.activated, pct(funnel.activated, funnel.tenants)],
    ["Activos últimos 7 días", funnel.active7, pct(funnel.active7, funnel.tenants)],
    ["Pagando", funnel.paying, pct(funnel.paying, funnel.tenants)],
  ];

  return (
    <div className="stack">
      {sp.ok && OK[sp.ok] ? <div className="notice ok">{OK[sp.ok]}</div> : null}
      {sp.error ? (
        <div className="notice err">
          {sp.error === "avisos_primero"
            ? "Recordatorios y el aviso de las 8 pm necesitan Avisos encendido: enciéndelos juntos."
            : sp.error === "aviso_primero"
              ? "«8 pm para todos» necesita el aviso de las 8 pm encendido."
              : sp.error === "puntos_primero"
                ? "Premios e Invitaciones necesitan Puntos encendido."
                : sp.error === "mes_pronto"
                  ? "Ese mes se puede aprobar 7 días después del pago del invitado."
                  : sp.error === "tope"
                    ? "El tope va de 0 a 200 US$, con hasta dos decimales."
                    : sp.error === "lote"
                      ? `No se programó el lote: ${sp.motivo && SCHEDULE_REFUSALS.has(sp.motivo) ? sp.motivo : "revisa el estado"}.`
                      : "No se pudo guardar el cambio."}
        </div>
      ) : null}

      <section className="card hero">
        <span className="label">Ingreso mensual recurrente</span>
        <p className="big num mint">{usd(revenue)}</p>
        <p className="sub num">
          Costos del mes: IA {usd(ai)} · Meta {usd(meta)} · margen{" "}
          <span className={revenue.minus(ai).minus(meta).isNegative() ? "amber" : "mint"}>
            {usd(revenue.minus(ai).minus(meta))}
          </span>
        </p>
        <div className="grid-3 admin-tiles">
          <div className="tile">
            <span className="label">Activos</span>
            <strong className="num tile-n">{count("active")}</strong>
          </div>
          <div className="tile">
            <span className="label">En prueba</span>
            <strong className="num tile-n">{count("trial")}</strong>
          </div>
          <div className="tile">
            <span className="label">Vencidos o suspendidos</span>
            <strong className="num tile-n amber">
              {count("grace") + count("expired") + count("suspended")}
            </strong>
          </div>
        </div>
      </section>

      <section className="card stack-sm">
        <div className="admin-head">
          <span className="label">Modo de lanzamiento</span>
          <span className={`badge ${launch.beta ? "warn" : "ok"}`}>
            {launch.beta ? "BETA" : "LIVE"}
          </span>
        </div>
        <form action={saveLaunchAction}>
          <input type="hidden" name="survey_day" value={launch.surveyDay} />
          <input type="hidden" name="value_day" value={launch.valueDay} />
          <fieldset className="switch2" aria-label="Modo de lanzamiento">
            <button type="submit" name="mode" value="beta" aria-pressed={launch.beta}>
              <strong className="sw-t">Beta</strong>
              <small>Sin precios en la prueba</small>
            </button>
            <button type="submit" name="mode" value="live" aria-pressed={!launch.beta}>
              <strong className="sw-t">Live</strong>
              <small>Con precios siempre</small>
            </button>
          </fieldset>
        </form>
        <p className="sub">
          {launch.beta
            ? 'Durante la prueba gratis Rocco no da precios: solo cuántos días y mensajes quedan. Al terminar la prueba muestra los precios y cómo pagar. La web dice "31 días o 100 mensajes gratis".'
            : "Rocco y la web muestran los precios siempre."}{" "}
          Toca el otro botón para cambiar; aplica desde el próximo mensaje.
        </p>
        <form action={saveLaunchAction} className="stack-sm admin-days">
          <input type="hidden" name="mode" value={launch.beta ? "beta" : "live"} />
          <span className="label">Ciclo de la prueba</span>
          <div className="grid-2 admin-grid">
            <label className="field">
              <span>Encuesta de precio, día</span>
              <input
                className="input"
                name="survey_day"
                type="number"
                min={1}
                max={TRIAL_DAYS - 1}
                defaultValue={launch.surveyDay}
              />
            </label>
            <label className="field">
              <span>Resumen y "¿seguimos?", día</span>
              <input
                className="input"
                name="value_day"
                type="number"
                min={1}
                max={TRIAL_DAYS - 1}
                defaultValue={launch.valueDay}
              />
            </label>
          </div>
          <button className="btn small secondary" type="submit">
            Guardar días
          </button>
        </form>
      </section>

      <section className="card tight">
        <span className="sect">
          Embudo
          {internal
            ? ` · sin ${internal} cuenta${internal === 1 ? "" : "s"} interna${internal === 1 ? "" : "s"}`
            : ""}
        </span>
        {steps.map(([label, n, note]) => (
          <div className="row" key={label}>
            <span className="what">
              <strong>{label}</strong>
              {note ? <span className="sub">{note}</span> : null}
            </span>
            <strong className="num">{n}</strong>
          </div>
        ))}
      </section>

      <section className="card tight">
        <span className="sect">Hábito · clientes</span>
        {habits ? (
          <>
            <div className="row">
              <span className="what">
                <strong>Racha 7+ días</strong>
                <span className="sub num">
                  de {habits.active} activos (7 d) · 2–6: {habits.streak2to6} · 30+:{" "}
                  {habits.streak30}
                </span>
              </span>
              <strong className="num">{habits.streak7}</strong>
            </div>
            <div className="row">
              <span className="what">
                <strong>Días con registro (28 d)</strong>
                <span className="sub num">
                  {habits.recordDays} de {habits.eligibleDays} días · mediana por usuario{" "}
                  {habits.medianPct === null ? "—" : `${Math.round(habits.medianPct)} %`} · sin
                  gastos (7 d): {habits.noSpendDays7}
                </span>
              </span>
              <strong className="num">
                {habits.eligibleDays
                  ? `${Math.round((habits.recordDays / habits.eligibleDays) * 100)} %`
                  : "—"}
              </strong>
            </div>
            <div className="row">
              <span className="what">
                <strong>Ventana abierta a las 8 pm (7 d)</strong>
                <span className="sub num">
                  {habits.windowOpen} de {habits.ownerDays} días-dueño · sin registro aún:{" "}
                  {habits.windowOpenNoRecord}
                </span>
              </span>
              <strong className="num">{habits.windowOpen}</strong>
            </div>
            <div className="row">
              <span className="what">
                <strong>Retención (registró) por semana de registro</strong>
                {habits.cohorts.length ? (
                  habits.cohorts.slice(0, 8).map((c) => (
                    <span className="sub num" key={c.week}>
                      {formatShortDate(c.week)} · {c.signedUp} · semana 2 (D7):{" "}
                      {c.d7Mature ? `${c.d7Recorded} de ${c.d7Mature}` : "—"} · semana 5 (D30):{" "}
                      {c.d30Mature ? `${c.d30Recorded} de ${c.d30Mature}` : "—"}
                    </span>
                  ))
                ) : (
                  <span className="sub">—</span>
                )}
              </span>
            </div>
          </>
        ) : (
          <p className="sub">
            No se pudo calcular: falta aplicar la migración 0025 (días sin gastos) en la base.
          </p>
        )}
        {nudges &&
        (habitFlags.nudge || nudges.sent > 0 || nudges.closes > 0 || nudges.optedIn > 0) ? (
          <div className="row">
            <span className="what">
              <strong>Aviso de las 8 pm (7 d)</strong>
              <span className="sub num">
                ofertas {nudges.offers} · aceptaron {nudges.optInsButton} con el botón y{" "}
                {nudges.optInsOther} por frase o panel · con el aviso {nudges.optedIn} (en pausa{" "}
                {nudges.paused})
              </span>
              <span className="sub num">
                cierres del día {nudges.closes} · avisos {nudges.sent} · fallidos {nudges.failed} ·
                cumplieron el día {nudges.answered} · «hoy no gasté nada» con el botón{" "}
                {nudges.noSpendButton} · pausas automáticas {nudges.autoPauses}
              </span>
            </span>
            <strong className="num">{nudges.sent + nudges.closes}</strong>
          </div>
        ) : null}
        {offs && habitFlags.prefs ? (
          <div className="row">
            <span className="what">
              <strong>Avisos apagados (14 d)</strong>
              <span className="sub num">
                no me recuerdes {offs.nudgeOffs} · no me escribas {offs.allOffs} · después de un
                mensaje de Rocco (24 h) {offs.offsAfterSend} · tarjetas sin contestar{" "}
                {offs.pendingCards}
              </span>
            </span>
            <strong className="num">{offs.nudgeOffs + offs.allOffs}</strong>
          </div>
        ) : null}
        {monthOut !== null ? (
          <div className="row">
            <span className="what">
              <strong>Mensajes enviados este mes</strong>
              <span className="sub">
                Todos los del número, con el registro. Meta regala 1.000 de servicio al mes; después
                cobra cada uno.
              </span>
            </span>
            <strong className="num">{monthOut}</strong>
          </div>
        ) : null}
        {reminders && (habitFlags.reminders || reminders.created > 0) ? (
          <div className="row">
            <span className="what">
              <strong>Recordatorios (7 d)</strong>
              <span className="sub num">
                creados {reminders.created} · a su hora {reminders.viaA} (a tiempo{" "}
                {reminders.onTime}) · adelantados {reminders.viaB} · al escribir {reminders.viaC} ·
                hechos {reminders.done} (con registro {reminders.linked}) · borrados{" "}
                {reminders.cancelled} · vencidos {reminders.expired}
                {reminders14 ? ` · fallidos (14 d) ${reminders14.failed}` : ""}
              </span>
              <span className="sub num">
                rechazados: no es de plata {reminders.rejectedNonMoney} · tope{" "}
                {reminders.rejectedLimit} · empleado {reminders.rejectedEmployee} · ediciones{" "}
                {reminders.edits} · dueños con 2+: {reminders.repeatOwners}
              </span>
            </span>
            <strong className="num">{reminders.created}</strong>
          </div>
        ) : null}
        <form action={saveHabitsAction} className="stack-sm admin-flags">
          <span className="label">Interruptores (para todos los clientes)</span>
          {(
            [
              [
                "streak_line",
                habitFlags.streakLine,
                "Línea de racha",
                "En la primera tarjeta guardada del día y la tarjeta «Tu racha» en Inicio",
              ],
              [
                "no_spend",
                habitFlags.noSpend,
                "«Hoy no gasté nada»",
                "El día sin gastos cuenta para la racha",
              ],
              [
                "prefs",
                habitFlags.prefs,
                "Avisos: apagar y encender",
                "«No me recuerdes», «no me escribas» y «mis avisos». Va primero y, una vez encendido, no se apaga",
              ],
              [
                "nudge",
                habitFlags.nudge,
                "Aviso de las 8 pm",
                "La oferta en una tarjeta del dueño con racha de 3 a 7 días (una vez) y el aviso a quien lo acepte. Necesita Avisos encendido y su aprobación (A-0033)",
              ],
              [
                "daily_close",
                habitFlags.dailyClose,
                "8 pm para todos (cierre del día)",
                "Sin que lo pidan: a quien escribió en las últimas 24 h, lo anotado hoy y «¿Falta algo?»; si no anotó nada, el aviso. Se apaga con «No me recuerdes». Necesita el aviso de las 8 pm encendido",
              ],
              [
                "reminders",
                habitFlags.reminders,
                "Recordatorios de plata",
                "Por chat y en el panel. Necesita Avisos encendido y la /privacidad nueva publicada",
              ],
            ] as const
          ).map(([name, on, title, note]) => (
            <label className="flag" key={name}>
              <input type="checkbox" name={name} defaultChecked={on} />
              <span className="what">
                <strong>{title}</strong>
                <span className="sub">{note}</span>
              </span>
              <span className={`badge ${on ? "ok" : ""}`}>{on ? "encendido" : "apagado"}</span>
            </label>
          ))}
          <p className="sub">
            Enciéndelos solo con su aprobación. Si una racha sale mal, apágalos aquí el mismo día.
          </p>
          <button className="btn small secondary" type="submit">
            Guardar hábito
          </button>
        </form>
      </section>

      <PointsCard
        flags={habitFlags}
        settings={points.settings}
        summary={points.summary}
        booked={points.booked}
        alert={points.alert}
        referrals={refs.summary}
        review={refs.review}
      />

      <section className="card stack-sm">
        <span className="sect">Registro: recordatorios</span>
        <p className="sub num" style={{ margin: 0 }}>
          Recordatorio del registro (30 días): enviados {rescue.windowSent} · terminaron después{" "}
          {rescue.windowFinished} · control {rescue.holdout} · terminaron {rescue.holdoutFinished}
        </p>
        <p className="sub num" style={{ margin: 0 }}>
          Plantilla del registro: enviadas {rescue.templateSent} · Seguir {rescue.templateResume} ·
          No me escribas {rescue.templateStop} · terminaron {rescue.templateFinished}
        </p>
        <p className="sub num" style={{ margin: 0 }}>
          Borrado a los 90 días: borrados {rescue.purgeDeleted} (últimos 90 días) · quedan solo
          número y marca {rescue.purgeKept}
        </p>
        <p className="sub" style={{ margin: 0 }}>
          Menos de 30: son números, no porcentajes.
        </p>
        <div className="stack-sm" id="lote">
          <span className="label">Lote de la plantilla (una sola vez, A-0031)</span>
          {lote?.status === "scheduled" ? (
            <>
              <p className="sub num" style={{ margin: 0 }}>
                Programado para el <strong>{loteWhen(lote.at)}</strong>: {lote.confirm}{" "}
                {lote.confirm === 1 ? "registro" : "registros"} · ${lote.costUsd.toFixed(2)}{" "}
                estimado. Sale solo, uno cada 90 s; apagar «Registro: plantilla (lote)» lo frena.
              </p>
              <form action={cancelBatchAction}>
                <button className="btn small secondary" type="submit">
                  Cancelar lote
                </button>
              </form>
            </>
          ) : lote?.status === "running" ? (
            <p className="sub" style={{ margin: 0 }}>
              El lote está corriendo ahora. Para frenarlo, apaga «Registro: plantilla (lote)».
            </p>
          ) : loteRan ? (
            <p className="sub num" style={{ margin: 0 }}>
              {lote?.result
                ? `El lote ya corrió: enviados ${lote.result.sent} · retenidos ${lote.result.held} · fallidos ${lote.result.failed} · «no me escribas» ${lote.result.optOuts} · sin enviar ${lote.result.unsent} · $${lote.result.costUsd.toFixed(2)}${lote.result.stop ? ` · parada ${lote.result.stop}` : ""}.`
                : lote?.reason === "se cortó"
                  ? "El lote se cortó a mitad (el worker se reinició)."
                  : "El lote ya corrió."}{" "}
              No hay segunda corrida.
            </p>
          ) : (
            <>
              {lote?.status === "missed" || lote?.status === "refused" ? (
                <p className="sub" style={{ margin: 0 }}>
                  El lote programado no salió ({lote.reason ?? "sin motivo"}). Puedes programarlo de
                  nuevo.
                </p>
              ) : null}
              <p className="sub num" style={{ margin: 0 }}>
                {lotePlan
                  ? `Si lo programas ahora: ${lotePlan.toSend} ${lotePlan.toSend === 1 ? "registro" : "registros"} (de ${lotePlan.eligible} elegibles) · $${lotePlan.costUsd.toFixed(2)} estimado.`
                  : "No se pudo calcular quiénes saldrían."}
              </p>
              <p className="sub" style={{ margin: 0 }}>
                Antes: marca «Le escribí yo» en los que contactaste y en tus números de prueba, y
                revisa en WhatsApp Manager calidad en verde, límite de 250 o más, método de pago y
                tarifa de marketing de $0,10 o menos. Ese día, ninguna otra campaña con plantilla.
              </p>
              <p className="sub" style={{ margin: 0 }}>
                Se programa la noche antes, desde las 6 pm.
              </p>
              <form action={scheduleBatchAction}>
                <button
                  className="btn small"
                  type="submit"
                  disabled={!lotePlan || lotePlan.toSend === 0}
                >
                  Programar lote para el {loteWhen(nextBatchSlot(now).toISOString())}
                </button>
              </form>
            </>
          )}
        </div>
        <form action={saveSignupRescueAction} className="stack-sm admin-flags">
          {(
            [
              ["in_window", rescueFlags.inWindow, "Registro: recordatorio en la ventana"],
              ["template", rescueFlags.template, "Registro: plantilla (lote)"],
              [
                "via_template",
                rescueFlags.inWindowVia === "template",
                "Registro: recordatorio como plantilla (no aprobado: déjalo apagado)",
              ],
            ] as const
          ).map(([name, on, title]) => (
            <label className="flag" key={name}>
              <input type="checkbox" name={name} defaultChecked={on} />
              <span className="what">
                <strong>{title}</strong>
              </span>
              <span className={`badge ${on ? "ok" : ""}`}>{on ? "encendido" : "apagado"}</span>
            </label>
          ))}
          <button className="btn small secondary" type="submit">
            Guardar registro
          </button>
        </form>
      </section>

      {funnel.abandoned.length ? (
        <section className="card tight" id="registros">
          <span className="sect">Registros sin terminar ({funnel.abandoned.length})</span>
          {funnel.abandoned.map((a) => (
            <div className="row admin-signup" key={a.e164}>
              <span className="what">
                <strong>{a.name ?? "Sin nombre"}</strong>
                <span className="sub num">
                  {formatE164(a.e164)} ·{" "}
                  {a.kind === "business"
                    ? "negocio"
                    : a.kind === "personal"
                      ? "personal"
                      : "sin elegir"}{" "}
                  · se quedó en «{STEP_LABEL[a.step] ?? a.step}» · {a.messages}{" "}
                  {a.messages === 1 ? "mensaje" : "mensajes"} ·{" "}
                  {formatShortDate(businessDateOf(a.updatedAt))}
                </span>
                <span className="chips">
                  {a.rescueVia === "window" && a.rescueAt ? (
                    <span className="badge">
                      Rocco le escribió · en la ventana · {ddmm(a.rescueAt)}
                    </span>
                  ) : null}
                  {a.rescueVia === "template" && a.rescueAt ? (
                    <span className="badge">
                      Rocco le escribió · plantilla · {ddmm(a.rescueAt)}
                    </span>
                  ) : null}
                  {a.rescueVia === "holdout" ? (
                    <span className="badge warn">
                      Grupo de control: no le escribas hasta el {HOLDOUT_UNTIL}
                    </span>
                  ) : null}
                  {a.contactOffAt ? <span className="badge">No quiere mensajes</span> : null}
                  {a.founderContactedAt ? (
                    <span className="badge">Le escribiste tú · {ddmm(a.founderContactedAt)}</span>
                  ) : null}
                </span>
              </span>
              <span className="actions">
                {a.rescueVia === "window" || a.rescueVia === "template" || a.contactOffAt ? null : (
                  <a
                    className="btn small secondary"
                    href={`https://wa.me/${a.e164}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Escribirle
                  </a>
                )}
                <form action={markFounderContactedAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="on" value={a.founderContactedAt ? "0" : "1"} />
                  <button className="btn small secondary" type="submit">
                    {a.founderContactedAt ? "Deshacer" : "Le escribí yo"}
                  </button>
                </form>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {Object.keys(survey.fair).length || Object.keys(survey.continue).length ? (
        <section className="card tight">
          <span className="sect">Encuesta de precio (al mes)</span>
          {es.PRICE_BUCKETS.map((b) => (
            <div className="row" key={b.id}>
              <span className="what">{b.title}</span>
              <span className="sub num">
                justo {survey.fair[b.id] ?? 0} · caro {survey.expensive[b.id] ?? 0}
              </span>
            </div>
          ))}
          <p className="sub admin-pad">
            ¿Seguimos?: sí {survey.continue.yes ?? 0} · tengo dudas {survey.continue.doubts ?? 0}
          </p>
        </section>
      ) : null}

      <section className="card">
        <span className="label">Cobro por pago móvil</span>
        {rates ? (
          <>
            <p className="kpi-sub num">
              Dólar BCV {ves(rates.usd)}
              {rates.eur ? ` · Euro BCV ${ves(rates.eur)}` : " · euro todavía sin publicar"}
              {premium ? ` · el euro está ${premium.toString().replace(".", ",")} % arriba` : ""}
              {` · ${formatShortDate(rates.effectiveDate as never)}`}
            </p>
            <div className="list admin-list">
              {PLANS.map((p) => {
                const q = quote(p, "pago_movil", 1, rates);
                return (
                  <div className={`row ${planClass(p.id)}`} key={p.id}>
                    <span className="what">
                      <strong className="plan-name">{p.name}</strong>
                      <span className="sub">{usd(p.priceUsd)} por Zelle o Binance</span>
                    </span>
                    <span className="amts num">
                      <strong>{q ? ves(q.amount) : "sin tasa"}</strong>
                      <span className="sub">
                        {q?.rateKind === "bcv_eur" ? "a tasa euro" : "a tasa dólar"}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="kpi-sub">Todavía no hay tasas BCV guardadas.</p>
        )}
      </section>

      <section className="card tight">
        <span className="sect">Pagos por verificar ({pending.length})</span>
        {pending.length === 0 ? (
          <p className="sub admin-pad">No hay pagos esperando.</p>
        ) : (
          pending.map((p) => (
            <div className="row admin-pay" key={p.id}>
              <span className="what">
                <strong>
                  <a href={`/admin/negocios/${p.tenantId}`}>{p.tenantName}</a>
                </strong>
                <span className="sub num">
                  {METHOD_LABEL[p.method]} · {p.currency === "VES" ? ves(p.amount) : usd(p.amount)}
                  {p.reference ? ` · ref ${p.reference}` : ""} · plan {p.plan}
                  {p.months > 1 ? ` × ${p.months} meses` : ""}
                  {p.kind === "recharge" ? ` · recarga +${p.extraMessages ?? 100} mensajes` : ""}
                  {p.notes?.includes("por WhatsApp") ? " · por WhatsApp" : ""}
                </span>
              </span>
              <span className="amts">
                <form action={approvePaymentAction}>
                  <input type="hidden" name="tenant_id" value={p.tenantId} />
                  <input type="hidden" name="payment_id" value={p.id} />
                  <input type="hidden" name="from" value="panel" />
                  <button className="btn small" type="submit">
                    Aprobar
                  </button>
                </form>
                <form action={rejectPaymentAction}>
                  <input type="hidden" name="tenant_id" value={p.tenantId} />
                  <input type="hidden" name="payment_id" value={p.id} />
                  <input type="hidden" name="from" value="panel" />
                  <button className="linkbtn" type="submit">
                    Rechazar
                  </button>
                </form>
              </span>
            </div>
          ))
        )}
      </section>

      {overCap.length ? (
        <div className="notice err">
          Sobre el límite del plan este mes:{" "}
          {overCap.map((t) => `${t.name} (${t.usage.inbound}/${t.cap})`).join(", ")}. Rocco dejó de
          registrar: ofréceles la recarga o el plan superior.
        </div>
      ) : null}

      <section className="card tight">
        <span className="sect">Negocios ({tenants.length})</span>
        {tenants.map((t) => (
          <a className="row admin-tenant" key={t.id} href={`/admin/negocios/${t.id}`}>
            <span className="what">
              <strong>{t.name}</strong>
              <span className="sub admin-plan-line">
                <span className={`plan-chip ${planClass(t.plan)}`}>
                  {PLANS.find((p) => p.id === t.plan)?.name ?? t.plan}
                </span>
                <span className={dueClass(t.state)}>{dueText(t.state)}</span>
                {t.founderUntil ? <span className="badge ok">fundador</span> : null}
                <span className="sub">{t.signupChannel === "whatsapp" ? "WhatsApp" : "web"}</span>
                {t.crmTags.map((tag) => (
                  <span className="badge" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
              <span className="sub num">
                {t.usage.inbound}/{t.cap} registros · IA {usd(t.usage.aiCostUsd)} · Meta{" "}
                {usd(t.metaCostUsd)}
                {t.pendingPayments ? ` · ${t.pendingPayments} pago por verificar` : ""}
              </span>
            </span>
            <span className="amts" style={{ gap: 6 }}>
              <span className={`badge ${HEALTH[t.health].cls}`} title="Último mensaje">
                {HEALTH[t.health].label}
              </span>
              {t.purgeAfter ? (
                <span className="badge late">papelera</span>
              ) : (
                <span className={`badge ${STATE[t.state.kind].cls}`}>
                  {STATE[t.state.kind].label}
                </span>
              )}
              <span
                className={`num sub ${t.marginUsd.isNegative() ? "due late" : ""}`}
                title="Margen del mes"
              >
                {usd(t.marginUsd)}
              </span>
            </span>
          </a>
        ))}
      </section>
    </div>
  );
}
