import type { BatchSchedule } from "@caja/core";
import type { AbandonedSignup, RescueFunnel } from "@/lib/admin";
import { cancelBatchAction, markFounderContactedAction, scheduleBatchAction } from "../actions";
import { Badge, Banner, Card, Checks, Facts, Head, Kpi } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";
import { MaskedPhone } from "../ui/phone";
import { ago } from "./pagos";

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
/** Hasta la lectura del grupo de control (PRD signup-reminders §7): 40 filas o el 31/12/2026. */
const HOLDOUT_UNTIL = "31/12/2026";

export type LoteState = {
  schedule: BatchSchedule | null;
  ran: boolean;
  plan: { toSend: number; eligible: number; costUsd: number } | null;
  /** «mar 10/11 10:00» de la próxima franja y de la programada. */
  nextWhen: string;
  scheduledWhen: string | null;
  /** La próxima franja queda a 16 h o menos (se programa la noche antes, desde las 6 pm). */
  inLeadWindow: boolean;
};

export type RegistroData = {
  banner: { ok: string | null; error: string | null };
  abandoned: AbandonedSignup[];
  toContact: number;
  rescue: RescueFunnel;
  lote: LoteState;
  now: Date;
};

const ddmm = (d: Date) => {
  const c = new Date(d.getTime() - 4 * 3_600_000);
  return `${String(c.getUTCDate()).padStart(2, "0")}/${String(c.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * /admin/registro: quién empezó el registro y no lo terminó (una tarjeta por persona, el teléfono
 * enmascarado), los números del recordatorio y el lote único de la plantilla (A-0031).
 */
export function RegistroView(d: RegistroData) {
  const r = d.rescue;
  return (
    <>
      <Head title="Registro" sub="Personas que empezaron el registro y no lo terminaron." />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      <div className="ad-grid ad-g4">
        <Kpi label="Sin terminar" value={d.abandoned.length} sub={`${d.toContact} por contactar`} />
        <Kpi
          label="Volvieron"
          value={`${r.windowFinished} de ${r.windowSent}`}
          sub="avisos en la ventana (30 días)"
        />
      </div>
      <Card
        id="registros"
        title="Registros sin terminar"
        right={<Badge tone={d.toContact ? "warn" : undefined}>{d.abandoned.length}</Badge>}
      >
        {d.abandoned.length === 0 ? (
          <p className="ad-empty">Nadie dejó el registro a medias.</p>
        ) : (
          <div className="ad-items">
            {d.abandoned.map((a) => {
              const rescued = a.rescueVia === "window" || a.rescueVia === "template";
              return (
                <div className="ad-item" key={a.id}>
                  <div className="ad-item-top">
                    <span className="ad-item-title">{a.name ?? "Sin nombre"}</span>
                    <Badge>
                      {a.kind === "business"
                        ? "negocio"
                        : a.kind === "personal"
                          ? "personal"
                          : "sin elegir"}
                    </Badge>
                  </div>
                  <Facts
                    rows={[
                      ["Se quedó en", `«${STEP_LABEL[a.step] ?? a.step}»`],
                      ["Mensajes", a.messages],
                      ["Última vez", ago(a.updatedAt, d.now)],
                      ["Teléfono", <MaskedPhone key="v" e164={a.e164} />],
                    ]}
                  />
                  {rescued ||
                  a.rescueVia === "holdout" ||
                  a.contactOffAt ||
                  a.founderContactedAt ? (
                    <span className="ad-badges">
                      {a.rescueVia === "window" && a.rescueAt ? (
                        <Badge>Rocco le escribió en la ventana el {ddmm(a.rescueAt)}</Badge>
                      ) : null}
                      {a.rescueVia === "template" && a.rescueAt ? (
                        <Badge>Rocco le escribió con la plantilla el {ddmm(a.rescueAt)}</Badge>
                      ) : null}
                      {a.rescueVia === "holdout" ? (
                        <Badge tone="warn">
                          Grupo de control: no le escribas hasta el {HOLDOUT_UNTIL}
                        </Badge>
                      ) : null}
                      {a.contactOffAt ? <Badge>No quiere mensajes</Badge> : null}
                      {a.founderContactedAt ? (
                        <Badge>Le escribiste tú el {ddmm(a.founderContactedAt)}</Badge>
                      ) : null}
                    </span>
                  ) : null}
                  <div className="ad-btns">
                    <form action={markFounderContactedAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="on" value={a.founderContactedAt ? "0" : "1"} />
                      <button className="ad-btn" type="submit">
                        {a.founderContactedAt ? "Deshacer" : "Le escribí yo"}
                      </button>
                    </form>
                    {rescued || a.contactOffAt ? null : (
                      <a
                        className="ad-btn pri"
                        href={`https://wa.me/${a.e164}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Escribirle
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <details className="ad-more">
        <summary>Más números del registro</summary>
        <div>
          <Facts
            rows={[
              ["Recordatorio en la ventana (30 días)", null],
              ["Enviados", r.windowSent],
              ["Terminaron después", r.windowFinished],
              ["Grupo de control", r.holdout],
              ["Del control, terminaron", r.holdoutFinished],
              ["Plantilla del registro", null],
              ["Enviadas", r.templateSent],
              ["Tocaron «Seguir»", r.templateResume],
              ["Tocaron «No me escribas»", r.templateStop],
              ["Terminaron después", r.templateFinished],
              ["Borrado a los 90 días", null],
              ["Borrados (últimos 90 días)", r.purgeDeleted],
              ["Quedan solo número y marca", r.purgeKept],
            ]}
          />
          <p className="ad-note">Menos de 30: son números, no porcentajes.</p>
        </div>
      </details>
      <Lote l={d.lote} />
    </>
  );
}

function Lote({ l }: { l: LoteState }) {
  const s = l.schedule;
  const status =
    s?.status === "scheduled"
      ? ["programado", "warn"]
      : s?.status === "running"
        ? ["corriendo", "warn"]
        : l.ran
          ? ["ya corrió", "ok"]
          : ["sin programar", ""];
  return (
    <Card
      id="lote"
      title="Lote de la plantilla (una sola vez, A-0031)"
      right={<Badge tone={status[1]}>{status[0]}</Badge>}
    >
      {s?.status === "scheduled" ? (
        <>
          <p className="ad-note">
            Programado para el <b>{l.scheduledWhen}</b>.
          </p>
          <Facts
            rows={[
              ["Registros", s.confirm],
              ["Costo estimado", `$${s.costUsd.toFixed(2)}`],
              ["Ritmo", "uno cada 90 s"],
            ]}
          />
          <p className="ad-note">Sale solo. Apagar «Plantilla (lote)» en Interruptores lo frena.</p>
          <form action={cancelBatchAction} className="ad-btns">
            <ConfirmButton
              label="Cancelar lote"
              title="¿Cancelar el lote programado?"
              body={
                <p className="ad-note">
                  «Plantilla (lote)» se apaga. Lo puedes programar de nuevo.
                </p>
              }
              ok="Sí, cancelar"
              danger
            />
          </form>
        </>
      ) : s?.status === "running" ? (
        <p className="ad-note">
          El lote está corriendo ahora. Para frenarlo, apaga «Plantilla (lote)» en Interruptores.
        </p>
      ) : l.ran ? (
        <>
          {s?.result ? (
            <Facts
              rows={[
                ["Enviados", s.result.sent],
                ["Retenidos", s.result.held],
                ["Fallidos", s.result.failed],
                ["«No me escribas»", s.result.optOuts],
                ["Sin enviar", s.result.unsent],
                ["Costo", `$${s.result.costUsd.toFixed(2)}`],
                ...(s.result.stop ? ([["Parada", s.result.stop]] as [string, string][]) : []),
              ]}
            />
          ) : (
            <p className="ad-note">
              {s?.reason === "se cortó"
                ? "El lote se cortó a mitad (el worker se reinició)."
                : "El lote ya corrió."}
            </p>
          )}
          <p className="ad-note">No hay segunda corrida.</p>
        </>
      ) : (
        <>
          {s?.status === "missed" || s?.status === "refused" ? (
            <div className="ad-alert">
              <span aria-hidden="true">!</span>
              <span>
                El lote programado no salió ({s.reason ?? "sin motivo"}). Puedes programarlo de
                nuevo.
              </span>
            </div>
          ) : null}
          {l.plan ? (
            <p className="ad-note" style={{ fontSize: 17 }}>
              Saldría a <b className="num">{l.plan.toSend}</b>{" "}
              {l.plan.toSend === 1 ? "persona" : "personas"} ·{" "}
              <b className="num">${l.plan.costUsd.toFixed(2)}</b>
            </p>
          ) : (
            <p className="ad-note">No se pudo calcular quiénes saldrían.</p>
          )}
          {l.plan ? (
            <p className="ad-note">
              De {l.plan.eligible} que podrían recibirla. Se manda una sola vez.
            </p>
          ) : null}
          <Checks
            rows={[
              {
                state: l.plan && l.plan.toSend > 0 ? "y" : "n",
                text: "Hay a quién enviarle",
              },
              {
                state: l.plan && l.plan.costUsd <= 3 ? "y" : "n",
                text: "El costo estimado no pasa de $3,00 (A-0031)",
              },
              {
                state: l.inLeadWindow ? "y" : "n",
                text: `Se programa la noche antes, desde las 6 pm (próxima salida: ${l.nextWhen})`,
              },
              {
                state: "q",
                text: "Marcaste «Le escribí yo» en los que contactaste y en tus números de prueba",
              },
              {
                state: "q",
                text: "WhatsApp Manager: calidad en verde, límite de 250 o más, método de pago y tarifa de marketing de $0,10 o menos",
              },
              { state: "q", text: "Ese día no hay ninguna otra campaña con plantilla" },
            ]}
          />
          <form action={scheduleBatchAction} className="ad-btns">
            <ConfirmButton
              label={`Programar para el ${l.nextWhen}`}
              className="ad-btn pri"
              disabled={!l.plan || l.plan.toSend === 0}
              title={`¿Programar el lote para el ${l.nextWhen}?`}
              body={
                <p className="ad-note">
                  Saldrá solo a {l.plan?.toSend ?? 0}{" "}
                  {l.plan?.toSend === 1 ? "persona" : "personas"}, uno cada 90 s, y «Plantilla
                  (lote)» se enciende. Es la única corrida: no hay segunda.
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
