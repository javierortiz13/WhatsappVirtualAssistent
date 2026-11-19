import type { ReaskSchedule, ReengageStats } from "@caja/core";
import { cancelReaskAction, scheduleReaskAction } from "../actions";
import { Badge, Card, Checks, Facts } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";

/** Por qué no salió la plantilla E1 (las claves de `ReengageSkip`), en palabras. */
const SKIP_LABEL: Record<string, string> = {
  kept_today: "Ya cumplió el día",
  run_done: "3 seguidas sin respuesta (corrida cortada)",
  cap_reached: "Tope del mes",
  no_cap: "Sin tope configurado",
  quality: "Calidad o plantilla no están bien (o no se leyeron)",
  held_today: "Meta retuvo una hoy",
  template_off: "Plantilla apagada",
  tenant_blocked: "Cuenta sin mensajes o suspendida",
  quiet_hours: "Horario nocturno",
  opted_out: "Apagó los avisos o «no-contactar»",
  pending_opt_out: "Tarjeta de apagar sin contestar",
  not_opted_in: "Sin el «Sí» de E3",
  paused: "En pausa",
  failed_recent: "Un envío falló en 7 días",
  slot_taken: "Ya recibió otro mensaje hoy",
  lifecycle_today: "Aviso de la prueba hoy",
  not_owner: "No es el dueño",
  internal: "Cuenta interna",
  window_closed: "Ventana cerrada (texto)",
};

const codes = (byCode: Record<string, number>): [string, number][] =>
  Object.entries(byCode)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [`Fallidas · código ${k}`, v]);

export type ReaskState = {
  schedule: ReaskSchedule | null;
  ran: boolean;
  plan: {
    toSend: number;
    eligible: number;
    costUsd: number;
    excluded: Record<string, number>;
  } | null;
  nextWhen: string;
  scheduledWhen: string | null;
  inLeadWindow: boolean;
  /** «Recordatorio a su hora (E3)» encendido: sin él no se programa. */
  on: boolean;
};

const EXCLUDE_LABEL: Record<string, string> = {
  employee: "Empleados",
  internal: "Cuentas internas",
  test: "Números de prueba",
  blocked: "Cuenta sin mensajes o suspendida",
  no_movement: "Nunca anotó",
  answered: "Ya contestó la pregunta",
  already_sent: "Ya recibió E3-t",
  opted_out: "Apagó los avisos",
  no_contact: "«no-contactar»",
  pending: "Tarjeta de apagar sin contestar",
  window_open: "Ventana abierta (le llega E3-r gratis)",
  founder: "«Le escribí yo» en 7 días",
};

/**
 * Retención E1–E3 en /admin/habito (agencia 19/11, A-0051 y A-0053): solo conteos de los últimos
 * 30 días, nunca teléfonos, nombres ni textos.
 */
export function RetencionCards({
  data,
  reask,
}: {
  data: {
    stats: ReengageStats;
    skips: Record<string, number>;
    capUsd: number | null;
    rateUsd: number | null;
  } | null;
  reask: ReaskState;
}) {
  if (!data)
    return (
      <div className="ad-alert">
        <span aria-hidden="true">!</span>
        <span>No se pudo calcular la retención: falta aplicar la migración 0039 en la base.</span>
      </div>
    );
  const { e1, e2, e3, e3t } = data.stats;
  const rate = data.rateUsd ?? 0.074;
  const cost = e1.monthTemplates * rate;
  return (
    <div className="ad-grid ad-g2">
      <Card title="E1 · plantilla a su hora · 30 días">
        <Facts
          rows={[
            ["Elegibles ahora", e1.eligibleNow],
            ["Enviadas", e1.sent],
            ["Entregadas", e1.delivered],
            ["Retenidas por calidad", e1.held],
            ["Fallidas", e1.failed],
            ...codes(e1.failedByCode),
            [
              "Costo del mes vs tope",
              `$${cost.toFixed(2)} de ${data.capUsd === null ? "sin tope (no sale ninguna)" : `$${data.capUsd.toFixed(2)}`}`,
            ],
            ["Anotaron en 24 h", `${e1.keptWithin24h} de ${e1.sent}`],
            ["Toques", null],
            ["«Anotar gasto»", e1.taps.expense],
            ["«Hoy no gasté»", e1.taps.noSpend],
            ["«No me escribas»", e1.taps.stop],
            ["«No me escribas» desde la plantilla (apagados)", e1.stopFromTemplate],
            ["Corridas cortadas en 3", e1.runsCutAt3],
          ]}
        />
        {Object.keys(data.skips).length ? (
          <Facts
            rows={[
              ["No salió (un teléfono por razón y día)", null],
              ...Object.entries(data.skips)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => [SKIP_LABEL[k] ?? k, v] as [string, number]),
            ]}
          />
        ) : null}
      </Card>
      <Card title="E3 · la pregunta · 30 días">
        <Facts
          rows={[
            ["Mostradas", null],
            ["E3 (primer movimiento)", e3.shown.E3],
            ["E3-n (de noche)", e3.shown["E3-n"]],
            ["E3-r (a quien ya anotó)", e3.shown["E3-r"]],
            ["«Sí, recuérdame»", e3.yes],
            ["«No, gracias»", e3.no],
            ["Sin respuesta", e3.noAnswer],
          ]}
        />
      </Card>
      <Card title="E2 · mensaje de la noche por arranque · 30 días">
        <div className="ad-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col">Arranque</th>
                <th scope="col">Enviados</th>
                <th scope="col">Anotaron en 2 h</th>
                <th scope="col">«No me recuerdes»</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(e2) as (keyof typeof e2)[]).map((v) => (
                <tr key={v}>
                  <td>{v}</td>
                  <td>{e2[v].sent}</td>
                  <td>{e2[v].keptWithin2h}</td>
                  <td>{e2[v].nudgeOffs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ad-note">Pocos envíos: léelo como dirección, no como ganador.</p>
      </Card>
      <ReaskCard r={reask} stats={e3t} />
    </div>
  );
}

function ReaskCard({ r, stats }: { r: ReaskState; stats: ReengageStats["e3t"] }) {
  const s = r.schedule;
  const status: [string, string] =
    s?.status === "scheduled"
      ? ["programado", "warn"]
      : s?.status === "running"
        ? ["corriendo", "warn"]
        : r.ran
          ? ["ya corrió", "ok"]
          : ["sin programar", ""];
  return (
    <Card
      id="e3t"
      title="E3-t · la pregunta por plantilla (una sola vez, A-0053)"
      right={<Badge tone={status[1]}>{status[0]}</Badge>}
    >
      {r.ran || stats.sent || stats.failed ? (
        <Facts
          rows={[
            ["Enviados", stats.sent],
            ["Entregados", stats.delivered],
            ["Retenidos", stats.held],
            ["Fallidos", stats.failed],
            ...codes(stats.failedByCode),
            ["«Sí, recuérdame»", stats.yes],
            ["«No, gracias»", stats.no],
            ["«No me escribas»", stats.stop],
            ["Sin respuesta a 72 h", stats.noAnswer72h],
          ]}
        />
      ) : null}
      {s?.status === "scheduled" ? (
        <>
          <p className="ad-note">
            Programado para el <b>{r.scheduledWhen}</b>: {s.confirm}{" "}
            {s.confirm === 1 ? "persona" : "personas"} · ${s.costUsd.toFixed(2)}, uno cada 90 s.
          </p>
          <p className="ad-note">Apagar «Recordatorio a su hora (E3)» en Interruptores lo frena.</p>
          <form action={cancelReaskAction} className="ad-btns">
            <ConfirmButton
              label="Cancelar lote"
              title="¿Cancelar el lote de E3-t?"
              body={<p className="ad-note">Lo puedes programar de nuevo.</p>}
              ok="Sí, cancelar"
              danger
            />
          </form>
        </>
      ) : s?.status === "running" ? (
        <p className="ad-note">Corriendo ahora.</p>
      ) : r.ran ? (
        <p className="ad-note">No hay segunda corrida.</p>
      ) : (
        <>
          {s?.status === "missed" || s?.status === "refused" ? (
            <div className="ad-alert">
              <span aria-hidden="true">!</span>
              <span>No salió ({s.reason ?? "sin motivo"}). Puedes programarlo de nuevo.</span>
            </div>
          ) : null}
          {r.plan ? (
            <>
              <p className="ad-note" style={{ fontSize: 17 }}>
                Saldría a <b className="num">{r.plan.toSend}</b>{" "}
                {r.plan.toSend === 1 ? "persona" : "personas"} ·{" "}
                <b className="num">${r.plan.costUsd.toFixed(2)}</b>
              </p>
              <Facts
                rows={[
                  ["Fuera", null],
                  ...Object.entries(r.plan.excluded)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => [EXCLUDE_LABEL[k] ?? k, n] as [string, number]),
                ]}
              />
            </>
          ) : (
            <p className="ad-note">No se pudo calcular quiénes saldrían.</p>
          )}
          <Checks
            rows={[
              { state: r.on ? "y" : "n", text: "«Recordatorio a su hora (E3)» encendido" },
              { state: r.plan && r.plan.toSend > 0 ? "y" : "n", text: "Hay a quién enviarle" },
              {
                state: r.plan && r.plan.costUsd <= 3 ? "y" : "n",
                text: "El costo estimado no pasa de $3,00 (A-0053)",
              },
              {
                state: r.inLeadWindow ? "y" : "n",
                text: `Se programa la noche antes, desde las 6 pm (próxima salida: ${r.nextWhen})`,
              },
              { state: "q", text: "Meta aprobó la plantilla como MARKETING y la agencia dio «OK»" },
              { state: "q", text: "Ese día no hay ninguna otra campaña con plantilla" },
            ]}
          />
          <form action={scheduleReaskAction} className="ad-btns">
            <ConfirmButton
              label={`Programar para el ${r.nextWhen}`}
              className="ad-btn pri"
              disabled={!r.on || !r.plan || r.plan.toSend === 0}
              title={`¿Programar E3-t para el ${r.nextWhen}?`}
              body={
                <p className="ad-note">
                  Saldrá solo a {r.plan?.toSend ?? 0}{" "}
                  {r.plan?.toSend === 1 ? "persona" : "personas"}, uno cada 90 s. Es la única
                  corrida: no hay segunda.
                </p>
              }
              ok="Programar"
            />
          </form>
        </>
      )}
    </Card>
  );
}
