import {
  addDays,
  businessDateOf,
  es,
  habitSettings,
  type Level,
  lastDayOfMonth,
  leyendaEnded,
  pointsView,
  syncPoints,
} from "@caja/core";
import { eq, schema, withTenant } from "@caja/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";

export const metadata: Metadata = { title: "Mis logros" };
export const dynamic = "force-dynamic";

const L = es.LOGROS;
const LEVELS: Level[] = [1, 2, 3, 4, 5];

/**
 * «Mis logros» (PRD hábitos v4.2.1 US-427, textos RW5 v1.2): nivel, barra, «Cómo sumar puntos»,
 * «Niveles y regalos» con su estado, las reversas y las reglas. Solo el dueño, solo con `habits.xp`
 * (si no, 404). Privada (SEC-P4-4: `PRIVATE_PREFIXES` y la sesión del dueño en el servidor).
 * P4-A: sin «Invita a tu gente» ni «Mi gente» (llegan con P4-B).
 */
export default async function Logros() {
  const { tenant } = await requireTenant();
  const flags = await habitSettings(db());
  if (!flags.xp) notFound();
  if (tenant.role !== "owner")
    return (
      <div className="stack">
        <p className="sub">{L.employee}</p>
      </div>
    );
  const now = new Date();
  const data = await withTenant(db(), tenant.id, async (tx) => {
    await syncPoints(tx, tenant.id, now, { flags });
    const [row] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenant.id));
    const v = await pointsView(tx, tenant.id, now);
    return {
      v,
      trial: row?.status === "trial",
      business: row?.businessType !== "personal",
      ended: v.level === 5 && (await leyendaEnded(tx, tenant.id)),
    };
  });
  const { v, trial, business, ended } = data;
  const today = businessDateOf(now);
  const bar = es.logrosBar({
    total: v.total,
    next: v.next,
    missing: v.missing,
    trial,
    leyendaEnded: ended,
  });
  const floor = es.levelMin(v.level);
  const ceil = v.next ? es.levelMin(v.next) : floor;
  const pct = v.next ? Math.min(100, Math.round(((v.total - floor) / (ceil - floor)) * 100)) : 100;
  const groups = es.pointsHowRows({
    business,
    flags: { dailyClose: flags.dailyClose, reminders: flags.reminders, referrals: false },
  });
  const rules = es.pointsRules({ dailyClose: flags.dailyClose });
  const updated = es.rulesUpdatedOn([]);
  const todayChip = es.logrosToday(v.today);
  return (
    <div className="stack">
      <section className="card hero stack-sm" aria-labelledby="lvl">
        <span className="label">{L.yourLevel}</span>
        <div className="row" style={{ gap: "var(--space-3)", alignItems: "center" }}>
          <span className="lvl-badge" role="img" aria-label={L.badgeAlt[v.level]}>
            {v.level}
          </span>
          <div className="stack-sm" style={{ minWidth: 0 }}>
            <h2 id="lvl" style={{ margin: 0 }}>
              {es.logrosLevel(v.level)}
            </h2>
            <span className="num">{es.logrosTotal(v.total)}</span>
          </div>
          {todayChip ? <span className="badge ok">{todayChip}</span> : null}
        </div>
        <p className="sub" style={{ margin: 0 }}>
          {bar.caption}
        </p>
        {bar.aria ? (
          <div
            className="lvl-bar"
            role="progressbar"
            aria-label={bar.aria}
            aria-valuemin={floor}
            aria-valuemax={ceil}
            aria-valuenow={v.total}
          >
            <i style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        <p className="sub" style={{ margin: 0 }}>
          {bar.under}
        </p>
        {v.onlySetup ? <p style={{ margin: 0 }}>{es.logrosEmpty(v.total)}</p> : null}
      </section>

      <details className="card stack-sm" open>
        <summary>
          <h2 style={{ display: "inline" }}>{L.howTitle}</h2>
        </summary>
        {groups.map((g) => (
          <div key={g.title} className="stack-sm">
            <span className="label">{g.title}</span>
            <ul className="lvl-rows">
              {g.rows.map((r) => (
                <li key={r.action}>
                  <span>
                    {r.action}
                    {r.note ? <span className="sub block">{r.note}</span> : null}
                  </span>
                  <span className="num">
                    {r.points}
                    {r.rule && v.done.includes(r.rule) ? (
                      <span className="badge ok" style={{ marginLeft: 8 }}>
                        {L.done}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>

      <section className="card stack-sm" aria-labelledby="niveles">
        <h2 id="niveles">{L.levelsTitle}</h2>
        <ul className="lvl-rows">
          {LEVELS.map((l) => {
            const grant = v.grants.find((g) => g.level === l) ?? null;
            const chip = es.levelChip({
              level: l,
              reached: v.level >= l,
              missing: Math.max(0, es.levelMin(l) - v.total),
              trial,
              grant,
              vence: lastDayOfMonth(today),
              fechaTope: addDays(lastDayOfMonth(today), 1),
              leyendaEnded: ended,
            });
            return (
              <li key={l}>
                <span>
                  <strong>{es.logrosLevel(l)}</strong>{" "}
                  <span className="sub">
                    · {l === 1 ? "desde 0 puntos" : `desde ${es.pts(es.levelMin(l))} puntos`}
                  </span>
                  <span className="sub block">{es.levelGiftText(l, trial)}</span>
                  <span className="block">{chip.line}</span>
                </span>
                {chip.chip ? <span className="badge">{chip.chip}</span> : null}
              </li>
            );
          })}
        </ul>
      </section>

      {v.reversals.length ? (
        <section className="card stack-sm">
          <ul className="lvl-rows">
            {v.reversals.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: líneas sin id propio, en orden fijo.
              <li key={i}>
                <span>{es.reversalLine(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="card stack-sm">
        <summary>
          <h2 style={{ display: "inline" }}>{L.rulesTitle}</h2>
        </summary>
        <ol className="stack-sm">
          {rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
        <p className="sub">Última actualización: {es.formatRulesDate(updated)}</p>
        <p className="sub">
          Las reglas completas: <a href="/puntos">{es.RULES_URL}</a>
        </p>
      </details>
    </div>
  );
}
