import type { HabitSettings, PointsSummary, RewardSettings } from "@caja/core";
import { dismissRewardsAlertAction, saveRewardsAction } from "./actions";

/**
 * «Puntos y premios» (PRD hábitos v4.2.1 §P4.9, US-413, US-429): filas 1–3 y 7, solo clientes y
 * solo conteos; con menos de 5 dueños en un nivel, solo el total (celdas chicas). Los interruptores
 * `Puntos`, `Premios` e `Invitaciones` (este, apagado hasta P4-B) y el tope en US$.
 */
export function PointsCard({
  flags,
  settings,
  summary,
  booked,
  alert,
}: {
  flags: HabitSettings;
  settings: RewardSettings;
  summary: PointsSummary | null;
  booked: number;
  alert: boolean;
}) {
  const s = summary;
  const typed = s ? s.bookedByType.messages + s.bookedByType.trial_days + s.bookedByType.week : 0;
  const byType = s
    ? `mensajes $${s.bookedByType.messages.toFixed(2)} · días de prueba $${s.bookedByType.trial_days.toFixed(2)} · semana $${s.bookedByType.week.toFixed(2)} · Leyenda $${Math.max(0, booked - typed).toFixed(2)}`
    : "";
  const switches = [
    [
      "xp",
      flags.xp,
      "Puntos",
      "Puntos y niveles, «mis puntos», «Mis logros» y la línea de «Eso es todo». Necesita /puntos publicado y su aprobación (A-0039)",
    ],
    [
      "rewards",
      flags.rewards,
      "Premios",
      "Los regalos de cada nivel, con el tope del mes. Necesita Puntos",
    ],
    [
      "referrals",
      flags.referrals,
      "Invitaciones",
      "Llega con la P4-B: todavía no se puede encender",
    ],
  ] as const;
  return (
    <section className="card stack-sm" id="puntos">
      <span className="sect">Puntos y premios</span>
      {alert ? (
        <div className="notice err">
          Dos meses seguidos por encima del tope de regalos. Cambia el tope o un regalo, o márcalo
          como visto.
          <form action={dismissRewardsAlertAction} style={{ marginTop: 8 }}>
            <button className="btn small secondary" type="submit">
              Visto
            </button>
          </form>
        </div>
      ) : null}
      {s ? (
        <>
          <p className="sub num" style={{ margin: 0 }}>
            1 · Puntos dados: este mes {s.pointsMonth} · 14 días {s.points14} · dueños con puntos
            (14 d) {s.ownersAwarded14} de {s.owners} · reversas {s.reversals}
          </p>
          <p className="sub num" style={{ margin: 0 }}>
            2 · Niveles ahora:{" "}
            {s.byLevel
              ? `N1 ${s.byLevel[1]} · N2 ${s.byLevel[2]} · N3 ${s.byLevel[3]} · N4 ${s.byLevel[4]} · N5 ${s.byLevel[5]}`
              : `${s.owners} dueños (menos de 5 en algún nivel: sin desglose)`}{" "}
            · subidas este mes:{" "}
            {s.levelUpsMonth
              ? `N2 ${s.levelUpsMonth[2]} · N3 ${s.levelUpsMonth[3]} · N4 ${s.levelUpsMonth[4]} · N5 ${s.levelUpsMonth[5]}`
              : s.levelUpsMonthTotal}
          </p>
          <p className="sub num" style={{ margin: 0 }}>
            3 · Costo este mes: ${booked.toFixed(2)} de ${settings.monthlyCeilingUsd.toFixed(2)} (
            {byType}) · esperando: tope {s.waiting.ceiling} · pago {s.waiting.not_paying} · apagado{" "}
            {s.waiting.flag_off} · pausa {s.waiting.paused} · topes alcanzados: este mes{" "}
            {s.ceilingHitsMonth}, el pasado {s.ceilingHitsLastMonth}
          </p>
          <p className="sub num" style={{ margin: 0 }}>
            7 · Señales (14 d): ráfagas S2 {s.s2BurstTenants} negocios · menos de $0,10 S3{" "}
            {s.s3Tiny} de {s.records14} · mismo monto en 60 min S4 {s.s4SameAmount} · borrados otro
            día S5 {s.s5LaterDelete}
          </p>
        </>
      ) : (
        <p className="sub" style={{ margin: 0 }}>
          Sin datos todavía (¿falta la migración 0035?).
        </p>
      )}
      <form action={saveRewardsAction} className="stack-sm admin-flags">
        <span className="label">Interruptores (para todos los clientes)</span>
        {switches.map(([name, on, title, note]) => (
          <label className="flag" key={name}>
            <input
              type="checkbox"
              name={name}
              defaultChecked={on}
              disabled={name === "referrals"}
            />
            <span className="what">
              <strong>{title}</strong>
              <span className="sub">{note}</span>
            </span>
            <span className={`badge ${on ? "ok" : ""}`}>{on ? "encendido" : "apagado"}</span>
          </label>
        ))}
        <label className="stack-sm">
          <span className="label">Tope de regalos del mes (US$, de 0 a 200)</span>
          <input
            className="input num"
            name="ceiling"
            inputMode="decimal"
            defaultValue={settings.monthlyCeilingUsd.toFixed(2)}
            aria-describedby="tope-ayuda"
          />
          <span className="sub" id="tope-ayuda">
            En 0, los regalos nuevos quedan guardados (pausa). Bajarlo es un recorte: se avisa 30
            días antes, salvo una pausa corta por abuso o falla.
          </span>
        </label>
        <button className="btn small secondary" type="submit">
          Guardar puntos
        </button>
      </form>
    </section>
  );
}
