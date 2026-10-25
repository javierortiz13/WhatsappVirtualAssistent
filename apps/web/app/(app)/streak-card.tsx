import { type Streak, weekday } from "@caja/core";

const SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/**
 * "Tu racha" en Inicio (PRD hábitos US-103, textos H5, H6 y H6b). Neutral: sin rojo ni avisos.
 * Los tres estados del día se distinguen por la forma del punto, no solo por el color.
 */
export function StreakCard({ streak, personal }: { streak: Streak; personal: boolean }) {
  const noSpend = personal ? "día sin gastos" : "día sin movimientos";
  const todayLine = streak.recordedToday
    ? "Hoy ya anotaste."
    : streak.noSpendToday
      ? `Hoy lo marcaste como ${noSpend}.`
      : "Hoy todavía no hay registros.";
  return (
    <section className="card streak">
      <span className="label">Tu racha</span>
      {!streak.everKept ? (
        <>
          <p className="kpi-sub">Tu racha arranca el día que anotes algo.</p>
          <p className="kpi-sub">Escríbele a Rocco: gasté 15$ en champú</p>
        </>
      ) : streak.current === 0 ? (
        <p className="kpi-sub">Cada día que anotes algo, tu racha suma uno.</p>
      ) : (
        <p className="kpi num">
          🔥 {streak.current === 1 ? "1 día" : `${streak.current} días seguidos`}
        </p>
      )}
      {streak.best >= 1 ? (
        <p className="kpi-sub num">Récord: {streak.best === 1 ? "1 día" : `${streak.best} días`}</p>
      ) : null}
      <p className="kpi-sub">{todayLine}</p>
      <ol className="streak-dots" aria-label="Los últimos 7 días">
        {streak.last7.map((d, i) => {
          const isToday = i === streak.last7.length - 1;
          const day = isToday ? "hoy" : LONG[weekday(d.date)];
          const said =
            d.state === "recorded"
              ? "anotado"
              : d.state === "no_spend"
                ? noSpend
                : isToday
                  ? "todavía no"
                  : "sin registros";
          return (
            <li key={d.date} className={`streak-day ${d.state}`}>
              <span className="streak-dot" aria-hidden="true" />
              <span className="day" aria-hidden="true">
                {isToday ? "hoy" : SHORT[weekday(d.date)]}
              </span>
              <span className="sr-only">{`${day}: ${said}`}</span>
            </li>
          );
        })}
      </ol>
      <p className="streak-legend" aria-hidden="true">
        <span className="streak-day recorded">
          <span className="streak-dot" /> Anotado
        </span>
        <span className="streak-day no_spend">
          <span className="streak-dot" /> {personal ? "Día sin gastos" : "Día sin movimientos"}
        </span>
        <span className="streak-day none">
          <span className="streak-dot" /> Sin registros
        </span>
      </p>
    </section>
  );
}
