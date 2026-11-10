import { es, PLANS, RECHARGE, REMOVE_REASONS, TRIAL_BUDGET_USD } from "@caja/core";
import { businessDateOf, formatShortDate } from "@caja/core/domain";
import type { Health, loadTenantDetail } from "@/lib/admin";
import {
  approvePaymentAction,
  changeTenantAction,
  eraseTenantAction,
  giftRechargeAction,
  recordPaymentAction,
  rejectPaymentAction,
  removePointsAction,
  restoreTenantAction,
  reversePaymentAction,
  saveCrmAction,
  setFounderAction,
  setReferralCodeAction,
} from "../actions";
import { initials } from "../derive";
import { dueText, METHOD_LABEL, planClass, STATE, usd, ves } from "../format";
import { Badge, Banner, Card, Facts } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";
import { MaskedPhone } from "../ui/phone";
import { HEALTH, planName } from "./client-row";
import { amountOf } from "./pagos";

export type Detail = Awaited<ReturnType<typeof loadTenantDetail>>;
export const TABS = ["resumen", "pagos", "numeros", "puntos", "acciones", "historial"] as const;
export type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  resumen: "Resumen",
  pagos: "Pagos",
  numeros: "Números",
  puntos: "Puntos",
  acciones: "Acciones",
  historial: "Historial",
};

const ACTION: Record<string, string> = {
  create: "Pago registrado",
  approve_payment: "Pago aprobado",
  reject: "Pago rechazado",
  change_plan: "Plan cambiado",
  extend: "Fecha extendida",
  suspend: "Suspendido a mano",
  reactivate: "Reactivado",
  trial_budget: "Tope de prueba cambiado",
  request_deletion: "Enviado a la papelera",
  restore: "Recuperado de la papelera",
  suspend_expired: "Suspendido por vencimiento",
  founder_on: "Precio fundador activado",
  founder_off: "Precio fundador quitado",
  remove_points: "Puntos quitados",
  reverse_payment: "Pago marcado como devuelto",
  disable_referral_code: "Código pausado",
  enable_referral_code: "Código reactivado",
  reward_trial_days: "Regalo: días de prueba",
  reward_free_week: "Regalo: semana del nivel Oro",
};
/** Estado de un regalo en /admin (nombres internos permitidos, §P4.8). */
const GRANT_STATUS: Record<string, string> = {
  applied: "aplicado",
  waiting: "esperando",
  test: "prueba (interna)",
  cancelled: "cancelado",
  refused: "rechazado",
  pending_review: "por revisar",
};
const WAIT_REASON: Record<string, string> = {
  ceiling: "tope del mes",
  not_paying: "espera un pago",
  flag_off: "Premios apagado",
  paused: "pausa (tope 0)",
};
const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "por verificar", cls: "warn" },
  approved: { label: "aprobado", cls: "ok" },
  rejected: { label: "rechazado", cls: "" },
  reversed: { label: "devuelto", cls: "late" },
};
const PHONE_STATUS: Record<string, string> = {
  active: "activo",
  pending: "sin vincular",
  disabled: "desactivado",
};

const day = (d: Date) => formatShortDate(businessDateOf(d));

export type NegocioData = {
  d: Detail;
  tab: Tab;
  banner: { ok: string | null; error: string | null };
  health: Health | null;
  launch: { surveyDay: number; valueDay: number };
  /** Monto sugerido por método, con fundador y Leyenda. */
  suggested: { pago_movil: string; zelle: string; binance: string };
  eurRate: boolean;
  /** Clave única de «Quitar puntos» (repetir el envío no quita dos veces). */
  actionId: string;
  /** Solo para las capturas: una hoja abierta. */
  openSheet?: "suspend";
};

/** Uso de un tope con barra (ámbar al 80 %, roja al pasarlo). */
function Meter({
  label,
  used,
  cap,
  note,
}: {
  label: string;
  used: number;
  cap: number;
  note: string;
}) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="ad-meter">
      <div className="ad-meter-top">
        <span>{label}</span>
        <span className="num">
          {used} de {cap}
        </span>
      </div>
      <span className="ad-bar" aria-hidden="true">
        <i className={used > cap ? "late" : pct >= 80 ? "warn" : ""} style={{ width: `${pct}%` }} />
      </span>
      <span className="ad-note">{note}</span>
    </div>
  );
}

/**
 * /admin/negocios/[id] (rediseño 08/11): cabecera con nombre, plan, estado, salud y fundador, y
 * pestañas (?tab=). Mismos datos, botones y reglas de antes; las acciones que cambian dinero o
 * plan piden confirmar.
 */
export function NegocioView(x: NegocioData) {
  const { d, tab } = x;
  const t = d.tenant;
  const extra = t.extraMonth === d.usage.month ? t.extraMessages : 0;
  const survey = (t.survey ?? {}) as Record<string, string | undefined>;
  const bucket = (id: string | undefined) =>
    id ? (es.PRICE_BUCKETS.find((b) => b.id === id)?.title ?? id) : "sin respuesta";
  return (
    <>
      <a className="ad-back" href="/admin/clientes">
        ← Clientes
      </a>
      <Banner ok={x.banner.ok} error={x.banner.error} />
      <section className="ad-card">
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          <span className="ad-av" style={{ width: 48, height: 48 }} aria-hidden="true">
            {initials(t.name)}
          </span>
          <h1 style={{ fontSize: 22, margin: 0, overflowWrap: "anywhere" }}>{t.name}</h1>
        </div>
        <span className="ad-badges">
          <Badge tone={planClass(t.plan)}>{d.plan.name}</Badge>
          {t.deletedAt ? (
            <Badge tone="late">papelera</Badge>
          ) : (
            <Badge tone={STATE[d.state.kind].cls}>{STATE[d.state.kind].label}</Badge>
          )}
          {x.health ? (
            <Badge tone={HEALTH[x.health].cls}>
              <span className={`ad-dot ${HEALTH[x.health].cls}`} aria-hidden="true" />
              {HEALTH[x.health].label}
            </Badge>
          ) : null}
          {t.founderUntil ? <Badge tone="ok">fundador</Badge> : null}
          {t.crmTags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
        <Facts
          rows={[
            ["Vence", dueText(d.state)],
            [
              "Alta",
              `${day(t.createdAt)}, ${t.signupChannel === "whatsapp" ? "por WhatsApp" : "por la web"}`,
            ],
          ]}
        />
      </section>
      <nav className="ad-dtabs" aria-label="Secciones del negocio">
        {TABS.map((k) => (
          <a
            key={k}
            className="ad-dtab"
            href={`/admin/negocios/${t.id}?tab=${k}`}
            aria-current={tab === k ? "page" : undefined}
          >
            {TAB_LABEL[k]}
          </a>
        ))}
      </nav>

      {tab === "resumen" ? (
        <div className="ad-grid ad-g2">
          <Card title="Uso del mes">
            {t.status === "trial" ? (
              <Meter
                label="Prueba gratis"
                used={d.trial.messages}
                cap={d.trial.messageCap}
                note={
                  d.trial.reached ? "Llegó al tope: el bot no registra" : "mensajes desde el alta"
                }
              />
            ) : null}
            <Meter
              label="Este mes"
              used={d.usage.inbound}
              cap={d.plan.messagesPerMonth + extra}
              note={extra ? `incluye +${extra} de recarga` : "mensajes del plan"}
            />
            <Facts
              rows={[
                ["Respuestas de Rocco", d.usage.outbound],
                [`IA (${d.usage.aiTurns} turnos)`, usd(d.usage.aiCostUsd)],
                ...(t.status === "trial"
                  ? ([
                      ["Prueba gratis, desde el alta", null],
                      [
                        `Gasto total (tope ${usd(d.trial.budgetUsd)}${t.trialBudgetUsd === null ? ", red de seguridad" : ", propio"})`,
                        <span key="v" className={d.trial.reached ? "ad-down" : ""}>
                          {usd(d.trial.spentUsd)}
                        </span>,
                      ],
                      ["IA", usd(d.trial.aiUsd)],
                      [`Meta (${d.trial.replies} respuestas)`, usd(d.trial.metaUsd)],
                      ["Notas de voz", usd(d.trial.voiceUsd)],
                    ] as [string, React.ReactNode][])
                  : []),
              ]}
            />
          </Card>
          <Card title="CRM">
            <Facts
              rows={[
                ["Precio fundador", null],
                [
                  t.founderUntil ? "40 % de descuento hasta el" : "Sin precio de fundador",
                  t.founderUntil ? formatShortDate(t.founderUntil as never) : "—",
                ],
                ["Encuesta y resumen", null],
                [
                  `Encuesta de precio (día ${x.launch.surveyDay})`,
                  t.surveySentAt ? `enviada ${day(t.surveySentAt)}` : "sin enviar",
                ],
                ["Precio justo", bucket(survey.fair)],
                ["Precio caro", bucket(survey.expensive)],
                [
                  `Resumen (día ${x.launch.valueDay})`,
                  t.valueSentAt ? `enviado ${day(t.valueSentAt)}` : "sin enviar",
                ],
                [
                  "¿Seguimos?",
                  survey.continue === "yes"
                    ? "sí"
                    : survey.continue === "doubts"
                      ? "tiene dudas"
                      : "sin respuesta",
                ],
              ]}
            />
            <div className="ad-btns">
              <form action={setFounderAction}>
                <input type="hidden" name="tenant_id" value={t.id} />
                <input type="hidden" name="founder" value={t.founderUntil ? "off" : "on"} />
                <button className="ad-btn" type="submit">
                  {t.founderUntil ? "Quitar fundador" : "Dar fundador (7 meses)"}
                </button>
              </form>
              <form action={giftRechargeAction}>
                <input type="hidden" name="tenant_id" value={t.id} />
                <button className="ad-btn" type="submit">
                  Regalar +{RECHARGE.messages} mensajes
                </button>
              </form>
            </div>
            <form action={saveCrmAction} className="ad-grid">
              <input type="hidden" name="tenant_id" value={t.id} />
              <label className="ad-field">
                Etiquetas, separadas por coma («interna» la saca del embudo y los ingresos)
                <input
                  name="tags"
                  defaultValue={t.crmTags.join(", ")}
                  placeholder="amigo, piloto"
                />
              </label>
              <label className="ad-field">
                Notas internas
                <textarea name="notes" rows={4} defaultValue={t.crmNotes ?? ""} />
              </label>
              <div className="ad-btns">
                <button className="ad-btn pri" type="submit">
                  Guardar notas
                </button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}

      {tab === "pagos" ? (
        <>
          <Card title="Registrar pago">
            <form action={recordPaymentAction} className="ad-grid">
              <input type="hidden" name="tenant_id" value={t.id} />
              <div className="ad-form">
                <label className="ad-field">
                  Plan
                  <select name="plan" defaultValue={t.plan}>
                    {PLANS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}, {usd(p.priceUsd)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ad-field">
                  Método
                  <select name="method" defaultValue="pago_movil">
                    <option value="pago_movil">Pago móvil (Bs)</option>
                    <option value="zelle">Zelle (USD)</option>
                    <option value="binance">Binance (USDT)</option>
                  </select>
                </label>
                <label className="ad-field">
                  Meses
                  <input name="months" type="number" min={1} max={12} defaultValue={1} />
                </label>
                <label className="ad-field">
                  Monto recibido
                  <input className="num" name="amount" inputMode="decimal" required />
                </label>
                <label className="ad-field">
                  Referencia
                  <input name="reference" maxLength={80} />
                </label>
                <label className="ad-field">
                  Notas
                  <input name="notes" maxLength={300} />
                </label>
              </div>
              <Facts
                rows={[
                  [`Plan ${d.plan.name}, 1 mes`, null],
                  [
                    `Pago móvil${x.eurRate ? " (tasa euro)" : " (tasa dólar)"}`,
                    ves(x.suggested.pago_movil || 0),
                  ],
                  ["Zelle", usd(x.suggested.zelle || 0)],
                  ["Binance", `${x.suggested.binance} USDT`],
                ]}
              />
              <label className="ad-check">
                <input type="checkbox" name="approve" defaultChecked /> Ya lo verifiqué: aprobar y
                activar
              </label>
              <div className="ad-btns">
                <ConfirmButton
                  label="Guardar pago"
                  className="ad-btn pri"
                  title={`¿Guardar el pago de ${t.name}?`}
                  body={
                    <p className="ad-note">
                      Si marcaste «Ya lo verifiqué», se aprueba y el plan queda activo con la nueva
                      fecha. Si no, queda por verificar.
                    </p>
                  }
                  ok="Guardar"
                />
              </div>
            </form>
          </Card>
          <Card title="Pagos">
            {d.payments.length === 0 ? <p className="ad-empty">Sin pagos todavía.</p> : null}
            <div className="ad-items">
              {d.payments.map((p) => (
                <div className="ad-item" key={p.id}>
                  <div className="ad-item-top">
                    <span className="ad-item-title num">{amountOf(p)}</span>
                    <Badge tone={PAY_STATUS[p.status]?.cls}>
                      {PAY_STATUS[p.status]?.label ?? p.status}
                    </Badge>
                  </div>
                  <Facts
                    rows={[
                      ["Método", METHOD_LABEL[p.method] ?? p.method],
                      [
                        "Para",
                        `Plan ${planName(p.plan)}, ${p.months} ${p.months === 1 ? "mes" : "meses"}${p.kind === "recharge" ? " (recarga)" : ""}`,
                      ],
                      ["Fecha", day(p.createdAt)],
                      ["Referencia", p.reference ?? "—"],
                      [
                        "Tasa",
                        p.rateKind === "bcv_eur"
                          ? "euro"
                          : p.rateKind === "bcv_usd"
                            ? "dólar"
                            : "—",
                      ],
                      ...(p.notes ? ([["Notas", p.notes]] as [string, string][]) : []),
                    ]}
                  />
                  {p.status === "pending" ? (
                    <div className="ad-btns">
                      <form action={rejectPaymentAction}>
                        <input type="hidden" name="tenant_id" value={t.id} />
                        <input type="hidden" name="payment_id" value={p.id} />
                        <ConfirmButton
                          label="Rechazar"
                          title={`¿Rechazar el pago de ${amountOf(p)}?`}
                          ok="Sí, rechazar"
                          danger
                        />
                      </form>
                      <form action={approvePaymentAction}>
                        <input type="hidden" name="tenant_id" value={t.id} />
                        <input type="hidden" name="payment_id" value={p.id} />
                        <ConfirmButton
                          label="Aprobar"
                          className="ad-btn pri"
                          title={`¿Aprobar el pago de ${amountOf(p)}?`}
                          body={
                            <p className="ad-note">Verifícalo en tu banco o billetera antes.</p>
                          }
                          ok="Aprobar"
                        />
                      </form>
                    </div>
                  ) : null}
                  {p.status === "approved" && p.kind === "plan" ? (
                    <form action={reversePaymentAction} className="ad-grid">
                      <input type="hidden" name="tenant_id" value={t.id} />
                      <input type="hidden" name="payment_id" value={p.id} />
                      <label className="ad-field">
                        Motivo de la devolución
                        <select name="reason">
                          <option value="devuelto">Devuelto</option>
                          <option value="contracargo">Contracargo</option>
                          <option value="error">Error al aprobar</option>
                        </select>
                      </label>
                      <div className="ad-btns">
                        <ConfirmButton
                          label="Marcar como devuelto"
                          title={`¿Marcar como devuelto el pago de ${amountOf(p)}?`}
                          body={
                            <p className="ad-note">
                              La vigencia no cambia: ajústala a mano si hace falta. Si vino por una
                              invitación, deja de contar.
                            </p>
                          }
                          ok="Marcar como devuelto"
                          danger
                        />
                      </div>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {tab === "numeros" ? (
        <Card title="Números">
          <div className="ad-items">
            {d.phones.map((p) => (
              <div className="ad-item" key={p.id}>
                <div className="ad-item-top">
                  <span className="ad-item-title">
                    {p.displayName ?? (p.role === "owner" ? "Dueño" : "Empleado")}
                  </span>
                  <Badge tone={p.status === "active" ? "ok" : "warn"}>
                    {PHONE_STATUS[p.status] ?? p.status}
                  </Badge>
                </div>
                <Facts
                  rows={[
                    ["Rol", p.role === "owner" ? "dueño" : "empleado"],
                    ["Teléfono", <MaskedPhone key="v" e164={p.e164} />],
                  ]}
                />
              </div>
            ))}
          </div>
          <p className="ad-note">
            {d.phones.filter((p) => p.status === "active").length} de {d.plan.numbers} números del
            plan.
          </p>
        </Card>
      ) : null}

      {tab === "puntos" ? (
        <Card title="Puntos" id="puntos">
          {d.points ? (
            <>
              <Facts
                rows={[
                  ["Nivel", `${es.logrosLevel(d.points.level)} (N${d.points.level})`],
                  ["Total", es.logrosTotal(d.points.total)],
                  ...(d.leyendaPct
                    ? ([["Leyenda", `${d.leyendaPct} % en el plan`]] as [string, string][])
                    : []),
                  ...d.points.grants.map(
                    (g) =>
                      [
                        `Regalo N${g.level}`,
                        `${GRANT_STATUS[g.status] ?? g.status}${g.waitReason ? `, ${WAIT_REASON[g.waitReason] ?? g.waitReason}` : ""}${g.appliedAs ? `, ${g.appliedAs}` : ""}`,
                      ] as [string, string],
                  ),
                  ...(d.referralCode
                    ? ([
                        [
                          "Código para invitar",
                          `${d.referralCode.code}${d.referralCode.disabledAt ? " (pausado)" : ""}`,
                        ],
                      ] as [string, string][])
                    : []),
                ]}
              />
              {d.referralCode ? (
                <form action={setReferralCodeAction} className="ad-btns">
                  <input type="hidden" name="tenant_id" value={t.id} />
                  <input
                    type="hidden"
                    name="op"
                    value={d.referralCode.disabledAt ? "enable" : "disable"}
                  />
                  <button className="ad-btn" type="submit">
                    {d.referralCode.disabledAt ? "Reactivar código" : "Pausar código"}
                  </button>
                </form>
              ) : null}
              {d.points.total > 0 ? (
                <form action={removePointsAction} className="ad-grid">
                  <input type="hidden" name="tenant_id" value={t.id} />
                  <input type="hidden" name="action_id" value={x.actionId} />
                  <div className="ad-form">
                    <label className="ad-field">
                      Puntos a quitar
                      <input
                        className="num"
                        name="points"
                        type="number"
                        min={1}
                        max={d.points.total}
                        defaultValue={1}
                      />
                    </label>
                    <label className="ad-field">
                      Motivo
                      <select name="reason">
                        {REMOVE_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {es.REMOVE_REASON_TEXT[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="ad-btns">
                    <ConfirmButton
                      label="Quitar puntos"
                      title={`¿Quitar puntos a ${t.name}?`}
                      body={
                        <p className="ad-note">Lo verá en su próxima respuesta, con el motivo.</p>
                      }
                      ok="Quitar puntos"
                      danger
                    />
                  </div>
                </form>
              ) : null}
            </>
          ) : (
            <p className="ad-empty">Sin puntos todavía (Puntos apagado o sin migración 0035).</p>
          )}
        </Card>
      ) : null}

      {tab === "acciones" ? (
        <>
          <Card title="Acciones sin pago">
            <form action={changeTenantAction} className="ad-grid">
              <input type="hidden" name="tenant_id" value={t.id} />
              <input type="hidden" name="op" value="plan" />
              <label className="ad-field">
                Plan
                <select name="plan" defaultValue={t.plan}>
                  {PLANS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ad-btns">
                <ConfirmButton
                  label="Cambiar plan"
                  title={`¿Cambiar el plan de ${t.name}?`}
                  body={
                    <p className="ad-note">
                      Sin pago: cambia el plan desde ya, con la misma fecha.
                    </p>
                  }
                  ok="Cambiar plan"
                />
              </div>
            </form>
            <form action={changeTenantAction} className="ad-grid">
              <input type="hidden" name="tenant_id" value={t.id} />
              <input type="hidden" name="op" value="extend" />
              <label className="ad-field">
                Días a extender
                <input name="days" type="number" min={1} max={366} defaultValue={7} />
              </label>
              <div className="ad-btns">
                <ConfirmButton
                  label="Extender días"
                  title={`¿Extender la fecha de ${t.name}?`}
                  body={
                    <p className="ad-note">Sin pago: suma esos días a su prueba o a su plan.</p>
                  }
                  ok="Extender"
                />
              </div>
            </form>
            {t.status === "trial" ? (
              <form action={changeTenantAction} className="ad-grid">
                <input type="hidden" name="tenant_id" value={t.id} />
                <input type="hidden" name="op" value="trial_budget" />
                <label className="ad-field">
                  Tope de gasto de la prueba (USD)
                  <input
                    className="num"
                    name="budget"
                    inputMode="decimal"
                    defaultValue={t.trialBudgetUsd ?? ""}
                    placeholder={`${TRIAL_BUDGET_USD} (por defecto)`}
                  />
                </label>
                <div className="ad-btns">
                  <button className="ad-btn" type="submit">
                    Guardar tope de prueba
                  </button>
                </div>
              </form>
            ) : null}
            <form action={changeTenantAction} className="ad-btns">
              <input type="hidden" name="tenant_id" value={t.id} />
              <input
                type="hidden"
                name="op"
                value={t.status === "suspended" ? "reactivate" : "suspend"}
              />
              {t.status === "suspended" ? (
                <button className="ad-btn pri" type="submit">
                  Reactivar
                </button>
              ) : (
                <ConfirmButton
                  label="Suspender ahora"
                  className="ad-btn dan"
                  title={`¿Suspender ahora a ${t.name}?`}
                  body={
                    <p className="ad-note">Rocco deja de responderle hasta que lo reactives.</p>
                  }
                  ok="Suspender"
                  danger
                  defaultOpen={x.openSheet === "suspend"}
                />
              )}
            </form>
          </Card>
          <Card title="Eliminar negocio">
            {t.deletedAt ? (
              <>
                <p className="ad-note">
                  En la papelera desde {day(t.deletedAt)}
                  {t.deletionReason === "unpaid"
                    ? " (90 días con el plan vencido)"
                    : t.deletionReason === "owner"
                      ? " (lo pidió el dueño)"
                      : ""}
                  . Se borra para siempre el {t.purgeAfter ? day(t.purgeAfter) : "próximo barrido"}.
                </p>
                <form action={restoreTenantAction} className="ad-btns">
                  <input type="hidden" name="tenant_id" value={t.id} />
                  <button className="ad-btn pri" type="submit">
                    Recuperar
                  </button>
                </form>
              </>
            ) : (
              <p className="ad-note">
                La papelera lo guarda 15 días (el dueño puede recuperarlo); «Borrar ya» lo elimina
                para siempre al instante: movimientos, cuentas, fotos, mensajes, números, pagos y
                acceso al panel.
              </p>
            )}
            <form action={eraseTenantAction} className="ad-grid">
              <input type="hidden" name="tenant_id" value={t.id} />
              <label className="ad-field">
                Escribe «{t.name}» para confirmar
                <input name="confirm" autoComplete="off" required />
              </label>
              <div className="ad-btns">
                {t.deletedAt ? null : (
                  <button className="ad-btn" type="submit" name="mode" value="trash">
                    A la papelera
                  </button>
                )}
                <button className="ad-btn dan" type="submit" name="mode" value="now">
                  Borrar ya
                </button>
              </div>
            </form>
          </Card>
        </>
      ) : null}

      {tab === "historial" ? (
        <Card title="Historial">
          {d.history.length === 0 ? (
            <p className="ad-empty">Sin cambios todavía.</p>
          ) : (
            <ul className="ad-tline">
              {d.history.map((h) => (
                <li key={h.id}>
                  <span>
                    {ACTION[h.action] ?? h.action}
                    <br />
                    <span className="w">
                      {day(h.createdAt)},{" "}
                      {h.actorType === "system" ? "automático" : "administrador"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}
