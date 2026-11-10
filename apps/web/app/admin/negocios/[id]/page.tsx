import { randomUUID } from "node:crypto";
import { latestRates, launchSettings, quote } from "@caja/core";
import { loadTenantDetail } from "@/lib/admin";
import { db } from "@/lib/db";
import { getAdmin, getNow, getTenants } from "../../data";
import { errorText, OK, type SectionParams } from "../../messages";
import { NegocioView, TABS, type Tab } from "../../views/negocio";

/** Ficha de un negocio (rediseño 08/11): cabecera y pestañas en ?tab=. */
export default async function AdminTenant({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SectionParams & { tab?: string }>;
}) {
  await getAdmin();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const now = getNow();
  const [d, rates, launch, tenants] = await Promise.all([
    loadTenantDetail(id, now),
    latestRates(db()),
    launchSettings(db()),
    getTenants(),
  ]);
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "resumen";
  const pick = (m: "pago_movil" | "zelle" | "binance") =>
    // Lo que el dueño ve en el chat: fundador y, si aplica, Leyenda (P4, US-417, A38).
    quote(d.plan, m, 1, rates, "bcv_eur", d.founderPct, d.leyendaPct)?.amount.toFixed(2) ?? "";
  return (
    <NegocioView
      d={d}
      tab={tab}
      banner={{ ok: sp.ok ? (OK[sp.ok] ?? null) : null, error: errorText(sp.error) }}
      health={tenants.find((t) => t.id === id)?.health ?? null}
      launch={{ surveyDay: launch.surveyDay, valueDay: launch.valueDay }}
      suggested={{ pago_movil: pick("pago_movil"), zelle: pick("zelle"), binance: pick("binance") }}
      eurRate={Boolean(rates?.eur)}
      actionId={randomUUID()}
    />
  );
}
