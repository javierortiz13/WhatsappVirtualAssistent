import type { HabitSettings, PointsSummary, ReferralSummary, RewardSettings } from "@caja/core";
import type { RefReviewRow } from "@/lib/admin";
import { dismissRewardsAlertAction, reviewRefMonthAction, saveRewardsAction } from "../actions";
import { Badge, Banner, Bars, Card, Facts, Head, Kpi } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";

export type PuntosData = {
  banner: { ok: string | null; error: string | null };
  flags: Pick<HabitSettings, "xp" | "rewards" | "referrals">;
  settings: RewardSettings;
  summary: PointsSummary | null;
  booked: number;
  alert: boolean;
  referrals: ReferralSummary | null;
  review: RefReviewRow[];
};

const FLAG_LABEL: Record<string, string> = {
  same_email: "mismo correo",
  same_payer: "mismos datos de pago",
  velocity: "más de 3 registros en 24 h",
};
const LEVELS = ["Cachorro", "Guardián", "Pana Fiel", "Oro", "Leyenda"] as const;
const $ = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;

/**
 * /admin/puntos: todo lo de «Puntos y premios» (PRD hábitos v4.2.1 §P4.9, US-413, US-429). Solo
 * clientes y solo conteos; con menos de 5 dueños en un nivel, solo el total. Los interruptores
 * están en «Interruptores»; aquí, el tope del mes y los meses de regalo por revisar.
 */
export function PuntosView(d: PuntosData) {
  const s = d.summary;
  const r = d.referrals;
  const typed = s ? s.bookedByType.messages + s.bookedByType.trial_days + s.bookedByType.week : 0;
  const allOff = !d.flags.xp && !d.flags.rewards && !d.flags.referrals;
  return (
    <>
      <Head
        title="Puntos e invitaciones"
        sub="Solo conteos de clientes. El invitado nunca tiene nombre."
      />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      {d.alert ? (
        <div className="ad-alert red">
          <span aria-hidden="true">!</span>
          <span style={{ display: "grid", gap: 8 }}>
            <span>
              <b>Dos meses seguidos por encima del tope de regalos.</b> Cambia el tope o un regalo,
              o márcalo como visto.
            </span>
            <form action={dismissRewardsAlertAction}>
              <button className="ad-btn" type="submit">
                Visto
              </button>
            </form>
          </span>
        </div>
      ) : null}
      {allOff ? (
        <div className="ad-alert">
          <span aria-hidden="true">⏸</span>
          <span>
            <b>Apagado.</b> Puntos y Premios ya tienen su aprobación (A-0039-T1): se encienden en{" "}
            <a href="/admin/interruptores">Interruptores</a>, con su código, cuando la agencia
            confirme el deploy. Invitaciones sigue pendiente (A-0039-T2).
          </span>
        </div>
      ) : null}
      {s ? (
        <div className="ad-grid ad-g4">
          <Kpi label="Puntos dados (mes)" value={s.pointsMonth} sub={`${s.points14} en 14 días`} />
          <Kpi
            label="Costo de regalos (mes)"
            value={`${$(d.booked)} de ${$(d.settings.monthlyCeilingUsd)}`}
            sub="el tope del mes"
          />
          <Kpi
            label="Invitaciones (90 d)"
            value={r ? r.signedUp90 : "—"}
            sub={r ? `${r.paid90} pagaron` : undefined}
          />
          <Kpi
            label="Por revisar"
            value={d.review.length + (r?.flagged ?? 0)}
            sub="meses de regalo y señales"
          />
        </div>
      ) : (
        <p className="ad-note">Sin datos todavía (¿falta la migración 0035?).</p>
      )}
      {s ? (
        <div className="ad-grid ad-g2">
          <Card title="Niveles ahora">
            {s.byLevel ? (
              <Bars
                rows={LEVELS.map((name, i) => ({
                  label: name,
                  value: s.byLevel?.[(i + 1) as 1 | 2 | 3 | 4 | 5] ?? 0,
                  max: s.owners || 1,
                }))}
              />
            ) : (
              <p className="ad-note">
                {s.owners} dueños. Con menos de 5 en algún nivel se muestra solo el total.
              </p>
            )}
            <Facts
              rows={[
                ["Subidas este mes", null],
                ...(s.levelUpsMonth
                  ? ([2, 3, 4, 5] as const).map(
                      (l) =>
                        [`A ${LEVELS[l - 1]} (N${l})`, s.levelUpsMonth?.[l] ?? 0] as [
                          string,
                          number,
                        ],
                    )
                  : ([["En total", s.levelUpsMonthTotal]] as [string, number][])),
              ]}
            />
          </Card>
          <Card title="Puntos · 14 días">
            <Facts
              rows={[
                ["Dueños con puntos", `${s.ownersAwarded14} de ${s.owners}`],
                ["Reversas", s.reversals],
                ["Señales de abuso", null],
                ["Ráfagas (S2)", `${s.s2BurstTenants} negocios`],
                ["Menos de $0,10 (S3)", `${s.s3Tiny} de ${s.records14}`],
                ["Mismo monto en 60 min (S4)", s.s4SameAmount],
                ["Borrados otro día (S5)", s.s5LaterDelete],
              ]}
            />
          </Card>
          <Card title="Costo de regalos · este mes">
            <Facts
              rows={[
                ["Mensajes", $(s.bookedByType.messages)],
                ["Días de prueba", $(s.bookedByType.trial_days)],
                ["Semana", $(s.bookedByType.week)],
                ["Leyenda", $(Math.max(0, d.booked - typed))],
                ["Esperando", null],
                ["Por el tope", s.waiting.ceiling],
                ["Por un pago", s.waiting.not_paying],
                ["Premios apagado", s.waiting.flag_off],
                ["En pausa (tope 0)", s.waiting.paused],
                ["Topes alcanzados", null],
                ["Este mes", s.ceilingHitsMonth],
                ["El mes pasado", s.ceilingHitsLastMonth],
              ]}
            />
          </Card>
          {r ? (
            <Card title="Invitaciones · 90 días y total">
              <Facts
                rows={[
                  ["Invitados por chat sin cuenta", r.invitedChat],
                  ["Se registraron", `${r.signedUp90} de ${r.signedUpAll}`],
                  ["Activos", `${r.active90} de ${r.activeAll}`],
                  ["Pagaron", `${r.paid90} de ${r.paidAll}`],
                  ["Terminadas", null],
                  ["Vencidas", r.ended.expired],
                  ["Ya usaban Rocco", r.ended.returning],
                  ["Devueltas", r.ended.reversed],
                  ["Rechazadas", r.ended.refused],
                  ["Meses de regalo", null],
                  ["Por revisar", r.months.pending_review],
                  ["Esperando pago", r.months.waiting],
                  ["Aplicados", r.months.applied],
                  ["Cancelados", r.months.cancelled],
                  [
                    "+50 del invitado (fuera del tope)",
                    `${r.inviteeBonus} (${$(r.inviteeBonusUsd)})`,
                  ],
                  ["Para revisar", null],
                  ["Invitaciones con señales", r.flagged],
                  ["Códigos pausados", r.codesDisabled],
                ]}
              />
            </Card>
          ) : null}
        </div>
      ) : null}
      <Card
        id="invitaciones"
        title="Meses de regalo por revisar"
        right={<Badge tone={d.review.length ? "warn" : undefined}>{d.review.length}</Badge>}
      >
        {d.review.length === 0 ? (
          <p className="ad-empty">
            Nada por revisar. Cuando alguien invite y su invitado pague, aparece aquí; se aprueba a
            los 7 días del pago.
          </p>
        ) : (
          <div className="ad-items">
            {d.review.map((g) => (
              <div className="ad-item" key={g.grantId}>
                <div className="ad-item-top">
                  <a className="ad-item-title" href={`/admin/negocios/${g.tenantId}?tab=puntos`}>
                    {g.tenantName}
                  </a>
                  <Badge tone="warn">hace {g.days} días</Badge>
                </div>
                <Facts
                  rows={[
                    [
                      "Plan de quien invita",
                      `${g.inviterPlan}${g.inviterPaying ? "" : " (no paga hoy)"}`,
                    ],
                    [
                      "Invitado",
                      g.inviteeErased
                        ? "cuenta invitada eliminada"
                        : `${g.inviteePlan ?? "—"}, $${g.inviteeAmountUsd ?? "—"}`,
                    ],
                    ...Object.entries(g.flags)
                      .filter(([, v]) => v)
                      .map(([k]) => ["Señal", `⚠ ${FLAG_LABEL[k] ?? k}`] as [string, string]),
                  ]}
                />
                <div className="ad-btns">
                  <form action={reviewRefMonthAction}>
                    <input type="hidden" name="tenant_id" value={g.tenantId} />
                    <input type="hidden" name="grant_id" value={g.grantId} />
                    <input type="hidden" name="op" value="refuse" />
                    <ConfirmButton
                      label="Rechazar"
                      title={`¿Rechazar el mes de regalo de ${g.tenantName}?`}
                      body={
                        <p className="ad-note">Quien invitó lo verá en su próxima respuesta.</p>
                      }
                      ok="Sí, rechazar"
                      danger
                    />
                  </form>
                  <form action={reviewRefMonthAction}>
                    <input type="hidden" name="tenant_id" value={g.tenantId} />
                    <input type="hidden" name="grant_id" value={g.grantId} />
                    <input type="hidden" name="op" value="approve" />
                    <ConfirmButton
                      label={g.canApprove ? "Aprobar" : "Aprobar (a los 7 días)"}
                      className="ad-btn pri"
                      disabled={!g.canApprove}
                      title={`¿Aprobar el mes de regalo de ${g.tenantName}?`}
                      body={<p className="ad-note">Se le suma un mes gratis de su plan.</p>}
                      ok="Aprobar"
                    />
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Tope de regalos del mes">
        <form action={saveRewardsAction} className="ad-grid">
          <input type="hidden" name="from" value="puntos" />
          <input type="hidden" name="xp" value={d.flags.xp ? "on" : ""} />
          <input type="hidden" name="rewards" value={d.flags.rewards ? "on" : ""} />
          <input type="hidden" name="referrals" value={d.flags.referrals ? "on" : ""} />
          <label className="ad-field">
            US$, de 0 a 200
            <input
              className="num"
              name="ceiling"
              inputMode="decimal"
              defaultValue={d.settings.monthlyCeilingUsd.toFixed(2)}
              aria-describedby="tope-ayuda"
            />
          </label>
          <p className="ad-note" id="tope-ayuda">
            En 0, los regalos nuevos quedan guardados (pausa). Bajarlo es un recorte: se avisa 30
            días antes, salvo una pausa corta por abuso o falla.
          </p>
          <div className="ad-btns">
            <ConfirmButton
              label="Guardar tope"
              className="ad-btn pri"
              title="¿Cambiar el tope de regalos del mes?"
              body={
                <p className="ad-note">
                  Hoy es {$(d.settings.monthlyCeilingUsd)}. Bajarlo es un recorte: avísalo 30 días
                  antes.
                </p>
              }
              ok="Guardar"
            />
          </div>
        </form>
      </Card>
    </>
  );
}
