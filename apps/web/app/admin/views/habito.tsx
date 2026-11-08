import type { HabitSummary, NudgeStats, ReminderStats } from "@caja/core";
import { formatShortDate } from "@caja/core/domain";
import { Banner, Card, Facts, Head, Kpi } from "../ui/bits";

export type HabitoData = {
  banner: { ok: string | null; error: string | null };
  habits: HabitSummary | null;
  /** El aviso de las 8 pm (7 d), si está encendido o ya salió alguno. */
  nudges: NudgeStats | null;
  /** Avisos apagados (14 d), con «Avisos» encendido. */
  offs: NudgeStats | null;
  /** Recordatorios (7 d), si están encendidos o ya hay alguno. */
  reminders: ReminderStats | null;
  /** Fallidos de recordatorios (14 d). */
  reminders14: ReminderStats | null;
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");

/** Una celda de la tabla de retención, más verde cuanto más se quedaron. */
function Cell({ n, of }: { n: number; of: number }) {
  if (!of) return <span style={{ color: "var(--muted-2)" }}>—</span>;
  const r = n / of;
  return (
    <span
      className="ad-heat"
      style={{ background: `rgba(63,224,176,${(0.08 + r * 0.4).toFixed(2)})` }}
    >
      {n} de {of}
    </span>
  );
}

/**
 * /admin/habito: solo conteos, sin datos de nadie. Las ventanas son las de siempre (7, 14 y 28 días)
 * y cada etiqueta dice la suya.
 */
export function HabitoView(d: HabitoData) {
  const h = d.habits;
  const offsTotal = d.offs ? d.offs.nudgeOffs + d.offs.allOffs : 0;
  return (
    <>
      <Head title="Hábito" sub="Solo conteos de clientes, sin datos de nadie." />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      {h ? (
        <>
          <div className="ad-grid ad-g4">
            <Kpi label="Racha de 7+ días" value={h.streak7} sub={`de ${h.active} activos (7 d)`} />
            <Kpi
              label="Días con registro (28 d)"
              value={pct(h.recordDays, h.eligibleDays)}
              sub={`${h.recordDays} de ${h.eligibleDays} días`}
            />
            <Kpi
              label="Ventana abierta a las 8 pm (7 d)"
              value={h.windowOpen}
              sub={`de ${h.ownerDays} días-dueño`}
            />
            <Kpi
              label="Avisos apagados (14 d)"
              value={d.offs ? offsTotal : "—"}
              tone={offsTotal ? "warn" : undefined}
            />
          </div>
          <Card title="Rachas y registros">
            <Facts
              rows={[
                ["Racha de 2 a 6 días", h.streak2to6],
                ["Racha de 30+ días", h.streak30],
                [
                  "Mediana por usuario (28 d)",
                  h.medianPct === null ? "—" : `${Math.round(h.medianPct)} %`,
                ],
                ["Días sin gastos (7 d)", h.noSpendDays7],
                ["Ventana abierta sin registro aún (7 d)", h.windowOpenNoRecord],
              ]}
            />
          </Card>
        </>
      ) : (
        <div className="ad-alert">
          <span aria-hidden="true">!</span>
          <span>
            No se pudo calcular: falta aplicar la migración 0025 (días sin gastos) en la base.
          </span>
        </div>
      )}
      <div className="ad-grid ad-g2">
        {d.nudges ? (
          <Card title="Aviso de las 8 pm · 7 días">
            <Facts
              rows={[
                ["Ofertas", d.nudges.offers],
                ["Aceptaron con el botón", d.nudges.optInsButton],
                ["Aceptaron por frase o panel", d.nudges.optInsOther],
                ["Con el aviso encendido", d.nudges.optedIn],
                ["En pausa", d.nudges.paused],
                ["Cierres del día", d.nudges.closes],
                ["Avisos enviados", d.nudges.sent],
                ["Fallidos", d.nudges.failed],
                ["Cumplieron el día", d.nudges.answered],
                ["«Hoy no gasté nada» con el botón", d.nudges.noSpendButton],
                ["Pausas automáticas", d.nudges.autoPauses],
              ]}
            />
          </Card>
        ) : null}
        {d.offs ? (
          <Card title="Avisos apagados · 14 días">
            <Facts
              rows={[
                ["«No me recuerdes»", d.offs.nudgeOffs],
                ["«No me escribas»", d.offs.allOffs],
                ["Después de un mensaje de Rocco (24 h)", d.offs.offsAfterSend],
                ["De esos, a la primera pregunta", d.offs.declinesAfterAsk],
                ["Tarjetas sin contestar (ahora)", d.offs.pendingCards],
              ]}
            />
          </Card>
        ) : null}
        {d.reminders ? (
          <Card title="Recordatorios · 7 días">
            <Facts
              rows={[
                ["Creados", d.reminders.created],
                ["A su hora", d.reminders.viaA],
                ["A tiempo", d.reminders.onTime],
                ["Adelantados", d.reminders.viaB],
                ["Al escribir", d.reminders.viaC],
                ["Hechos", d.reminders.done],
                ["Hechos con registro", d.reminders.linked],
                ["Borrados", d.reminders.cancelled],
                ["Vencidos", d.reminders.expired],
                ...(d.reminders14
                  ? ([["Fallidos (14 d)", d.reminders14.failed]] as [string, number][])
                  : []),
                ["Rechazados", null],
                ["No es de plata", d.reminders.rejectedNonMoney],
                ["Llegó al tope", d.reminders.rejectedLimit],
                ["Lo pidió un empleado", d.reminders.rejectedEmployee],
                ["Ediciones", d.reminders.edits],
                ["Dueños con 2 o más", d.reminders.repeatOwners],
              ]}
            />
          </Card>
        ) : null}
      </div>
      {h ? (
        <Card title="Retención por semana de registro">
          {h.cohorts.length ? (
            <div className="ad-scroll">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col">Semana</th>
                    <th scope="col">Altas</th>
                    <th scope="col">Semana 2 (D7)</th>
                    <th scope="col">Semana 5 (D30)</th>
                  </tr>
                </thead>
                <tbody>
                  {h.cohorts.slice(0, 8).map((c) => (
                    <tr key={c.week}>
                      <td>{formatShortDate(c.week)}</td>
                      <td>{c.signedUp}</td>
                      <td>
                        <Cell n={c.d7Recorded} of={c.d7Mature} />
                      </td>
                      <td>
                        <Cell n={c.d30Recorded} of={c.d30Mature} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ad-empty">—</p>
          )}
          <p className="ad-note">
            Registró: cuenta quien anotó algo esa semana. Menos de 30 por semana: son números, no
            porcentajes.
          </p>
        </Card>
      ) : null}
    </>
  );
}
