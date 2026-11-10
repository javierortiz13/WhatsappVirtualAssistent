import { es, launchSettings, PLANS, premiumOverUsd, quote, TRIAL_DAYS } from "@caja/core";
import { loadRates, surveyTally } from "@/lib/admin";
import { db } from "@/lib/db";
import { getAdmin, getTenants } from "../data";
import { errorText, OK, type SectionParams } from "../messages";
import { CobroView } from "../views/cobro";

/** /admin/cobro: tasas, precios en Bs, modo de lanzamiento, días de la prueba y la encuesta. */
export default async function AdminCobro({
  searchParams,
}: {
  searchParams: Promise<SectionParams>;
}) {
  await getAdmin();
  const sp = await searchParams;
  const [rates, launch, tenants] = await Promise.all([
    loadRates(),
    launchSettings(db()),
    getTenants(),
  ]);
  const survey = surveyTally(tenants);
  const premium = rates ? premiumOverUsd(rates) : null;
  return (
    <CobroView
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      rates={
        rates
          ? {
              usd: rates.usd.toString(),
              eur: rates.eur ? rates.eur.toString() : null,
              effectiveDate: String(rates.effectiveDate),
            }
          : null
      }
      premium={premium ? premium.toString() : null}
      prices={PLANS.map((p) => {
        const q = rates ? quote(p, "pago_movil", 1, rates) : null;
        return {
          id: p.id,
          amount: q ? q.amount.toString() : null,
          rate: q ? (q.rateKind === "bcv_eur" ? "euro" : "dólar") : null,
        };
      })}
      launch={launch}
      trialDays={TRIAL_DAYS}
      survey={{
        buckets: es.PRICE_BUCKETS.map((b) => ({
          id: b.id,
          title: b.title,
          fair: survey.fair[b.id] ?? 0,
          expensive: survey.expensive[b.id] ?? 0,
        })),
        yes: survey.continue.yes ?? 0,
        doubts: survey.continue.doubts ?? 0,
        any: Object.keys(survey.fair).length > 0 || Object.keys(survey.continue).length > 0,
      }}
    />
  );
}
