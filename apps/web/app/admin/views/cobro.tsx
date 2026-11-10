import { formatShortDate } from "@caja/core/domain";
import { PLANS } from "@caja/core/plans";
import { saveLaunchAction } from "../actions";
import { planClass, usd, ves } from "../format";
import { Badge, Banner, Card, Facts, Head, Kpi } from "../ui/bits";
import { ConfirmButton } from "../ui/confirm";

export type CobroData = {
  banner: { ok: string | null; error: string | null };
  rates: { usd: string; eur: string | null; effectiveDate: string } | null;
  premium: string | null;
  /** Precio en Bs por pago móvil de cada plan (1 mes), con la tasa que usa. */
  prices: { id: string; amount: string | null; rate: "euro" | "dólar" | null }[];
  launch: { beta: boolean; surveyDay: number; valueDay: number };
  trialDays: number;
  survey: {
    buckets: { id: string; title: string; fair: number; expensive: number }[];
    yes: number;
    doubts: number;
    any: boolean;
  };
};

/** /admin/cobro: tasas BCV, precio de cada plan en Bs, modo de lanzamiento, días de la prueba. */
export function CobroView(d: CobroData) {
  const mode = d.launch.beta ? "beta" : "live";
  return (
    <>
      <Head title="Cobro y tasas" sub="Montos para pago móvil al día de hoy." />
      <Banner ok={d.banner.ok} error={d.banner.error} />
      {d.rates ? (
        <div className="ad-grid ad-g4">
          <Kpi
            label="Dólar BCV"
            value={ves(d.rates.usd)}
            sub={formatShortDate(d.rates.effectiveDate as never)}
          />
          <Kpi
            label="Euro BCV"
            value={d.rates.eur ? ves(d.rates.eur) : "—"}
            sub={
              d.rates.eur
                ? d.premium
                  ? `${d.premium.replace(".", ",")} % arriba del dólar`
                  : undefined
                : "todavía sin publicar"
            }
          />
        </div>
      ) : (
        <p className="ad-note">Todavía no hay tasas BCV guardadas.</p>
      )}
      <Card title="Precio por plan (1 mes)">
        <div className="ad-items">
          {PLANS.map((p) => {
            const q = d.prices.find((x) => x.id === p.id);
            return (
              <div className="ad-item" key={p.id}>
                <div className="ad-item-top">
                  <Badge tone={planClass(p.id)}>{p.name}</Badge>
                </div>
                <Facts
                  rows={[
                    ["Pago móvil", q?.amount ? <b key="v">{ves(q.amount)}</b> : "sin tasa"],
                    ["Tasa", q?.rate ? `a tasa ${q.rate}` : "—"],
                    ["Zelle o Binance", usd(p.priceUsd)],
                  ]}
                />
              </div>
            );
          })}
        </div>
      </Card>
      <Card
        title="Modo de lanzamiento"
        right={
          <Badge tone={d.launch.beta ? "warn" : "ok"}>{d.launch.beta ? "BETA" : "LIVE"}</Badge>
        }
      >
        <form action={saveLaunchAction} className="ad-grid">
          <input type="hidden" name="survey_day" value={d.launch.surveyDay} />
          <input type="hidden" name="value_day" value={d.launch.valueDay} />
          <div className="ad-btns">
            <ConfirmButton
              label={
                <span style={{ display: "grid" }}>
                  <span>Beta</span>
                  <small style={{ fontWeight: 400, fontSize: 14 }}>Sin precios en la prueba</small>
                </span>
              }
              className={`ad-btn${mode === "beta" ? " pri" : ""}`}
              disabled={mode === "beta"}
              name="mode"
              value="beta"
              title="¿Pasar a Beta?"
              body={
                <p className="ad-note">
                  Durante la prueba gratis Rocco no da precios: solo cuántos días y mensajes quedan.
                  Aplica desde el próximo mensaje.
                </p>
              }
              ok="Pasar a Beta"
            />
            <ConfirmButton
              label={
                <span style={{ display: "grid" }}>
                  <span>Live</span>
                  <small style={{ fontWeight: 400, fontSize: 14 }}>Con precios siempre</small>
                </span>
              }
              className={`ad-btn${mode === "live" ? " pri" : ""}`}
              disabled={mode === "live"}
              name="mode"
              value="live"
              title="¿Pasar a Live?"
              body={
                <p className="ad-note">
                  Rocco y la web muestran los precios siempre. Aplica desde el próximo mensaje.
                </p>
              }
              ok="Pasar a Live"
            />
          </div>
        </form>
        <p className="ad-note">
          {d.launch.beta
            ? "Durante la prueba gratis Rocco no da precios: solo cuántos días y mensajes quedan. Al terminar la prueba muestra los precios y cómo pagar. La web dice «31 días o 100 mensajes gratis»."
            : "Rocco y la web muestran los precios siempre."}
        </p>
      </Card>
      <Card title="Ciclo de la prueba">
        <form action={saveLaunchAction} className="ad-grid">
          <input type="hidden" name="mode" value={mode} />
          <div className="ad-form">
            <label className="ad-field">
              Encuesta de precio, día
              <input
                name="survey_day"
                type="number"
                min={1}
                max={d.trialDays - 1}
                defaultValue={d.launch.surveyDay}
              />
            </label>
            <label className="ad-field">
              Resumen y «¿seguimos?», día
              <input
                name="value_day"
                type="number"
                min={1}
                max={d.trialDays - 1}
                defaultValue={d.launch.valueDay}
              />
            </label>
          </div>
          <div className="ad-btns">
            <button className="ad-btn" type="submit">
              Guardar días
            </button>
          </div>
        </form>
      </Card>
      {d.survey.any ? (
        <Card title="Encuesta de precio (al mes)">
          <Facts
            rows={[
              ...d.survey.buckets.flatMap(
                (b) =>
                  [
                    [b.title, null],
                    ["Justo", b.fair],
                    ["Caro", b.expensive],
                  ] as [string, number | null][],
              ),
              ["¿Seguimos?", null],
              ["Sí", d.survey.yes],
              ["Tengo dudas", d.survey.doubts],
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}
